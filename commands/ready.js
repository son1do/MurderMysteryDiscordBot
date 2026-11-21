const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { getPlList } = require('../lib/state');
const { createProgressBar } = require('../lib/utils');
const { playChimeIfConnected } = require('../lib/voice');

const readySessions = new Map();

class ReadySession {
  constructor({ guildId, title, startedBy, targetUsers = null, targetCount = null }) {
    this.guildId = guildId;
    this.title = title;
    this.startedBy = startedBy;
    this.targetUsers = targetUsers;
    this.targetCount = targetUsers ? targetUsers.size : targetCount;
    this.readyUsers = new Map();
    this.message = null;
    this.isOpen = true;
  }

  toggleUser(userId, displayName) {
    if (this.readyUsers.has(userId)) {
      this.readyUsers.delete(userId);
      return false;
    }
    this.readyUsers.set(userId, displayName);
    return true;
  }

  isAllReady() {
    if (this.targetUsers && this.targetUsers.size > 0) {
      for (const userId of this.targetUsers.keys()) {
        if (!this.readyUsers.has(userId)) return false;
      }
      return true;
    }
    if (this.targetCount && this.targetCount > 0) {
      return this.readyUsers.size >= this.targetCount;
    }
    return false;
  }

  buildEmbed(finished = false) {
    const readyCount = this.readyUsers.size;
    const total = this.targetCount;
    const progressText = total
      ? `${createProgressBar(readyCount, total, 10)} **${readyCount} / ${total}名**`
      : `**${readyCount}名** が完了`;

    const readyNames = [...this.readyUsers.values()];
    const readyFieldValue = readyNames.length > 0 ? readyNames.map(n => `✅ ${n}`).join('\n') : 'まだいません';

    const embed = new EmbedBuilder()
      .setTitle(finished ? `🎉 ${this.title} — 全員完了！` : `📖 ${this.title} — 準備OKチェック`)
      .setColor(finished ? 0x2ECC71 : 0x3498DB)
      .setDescription(
        finished
          ? `全員の準備が完了しました！次のフェーズへ進めます。\n\n${progressText}`
          : `読み込み・準備が終わったら下の **「✅ 読み込み完了！」** ボタンを押してください。\n（もう一度押すと取り消せます）\n\n${progressText}`
      )
      .addFields({ name: `✅ 完了済み (${readyCount}名)`, value: readyFieldValue.slice(0, 1024), inline: true })
      .setTimestamp();

    if (this.targetUsers && this.targetUsers.size > 0) {
      const waitingNames = [];
      for (const [uid, name] of this.targetUsers.entries()) {
        if (!this.readyUsers.has(uid)) waitingNames.push(name);
      }
      const waitingValue = waitingNames.length > 0 ? waitingNames.map(n => `⏳ ${n}`).join('\n') : 'なし（全員完了！）';
      embed.addFields({ name: `⏳ 読み込み中 (${waitingNames.length}名)`, value: waitingValue.slice(0, 1024), inline: true });
    }

    embed.setFooter({
      text: finished
        ? 'チェック完了済み'
        : total
          ? '全員が押すと自動で完了通知が鳴ります'
          : 'GMが「締め切る」を押すと終了します',
    });

    return embed;
  }

  buildButtonRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ready_toggle')
        .setLabel('読み込み完了！')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('ready_finish')
        .setLabel('締め切る (GM)')
        .setEmoji('🔔')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ready')
    .setDescription('ハンドアウト読み込み完了・準備OKチェックを行います')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('読み込み完了チェックを開始します（全員完了で自動通知＆チャイム）')
        .addStringOption(opt =>
          opt
            .setName('title')
            .setDescription('チェックのタイトル（例: ハンドアウト読み込み、エンディング確認）')
            .setRequired(false)
        )
        .addIntegerOption(opt =>
          opt
            .setName('target_count')
            .setDescription('目標人数（省略時はVCメンバーまたは /pl 人数から自動設定）')
            .setMinValue(1)
            .setMaxValue(30)
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('include_self')
            .setDescription('VCメンバー自動取得時に実行者（あなた）も含めるか（GMレス時は True）')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('cancel').setDescription('進行中の読み込み完了チェックを中止します（作成者のみ）')
    ),
  buttonPrefixes: ['ready_'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'start') {
      if (readySessions.has(guildId)) {
        return interaction.reply({
          content: '⚠️ すでに進行中の読み込み完了チェックがあります。先に締め切るか `/ready cancel` で中止してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const title = (interaction.options.getString('title') || 'ハンドアウト読み込み').trim();
      const explicitCount = interaction.options.getInteger('target_count');
      const includeSelf = interaction.options.getBoolean('include_self') ?? false;

      let targetUsers = null;
      let targetCount = explicitCount || null;

      if (!targetCount) {
        const memberVoice = interaction.member.voice;
        if (memberVoice?.channel) {
          const humanMembers = memberVoice.channel.members.filter(m => !m.user.bot);
          const filtered = includeSelf
            ? humanMembers
            : humanMembers.filter(m => m.id !== interaction.user.id);
          const chosen = filtered.size > 0 ? filtered : humanMembers;
          if (chosen.size > 0) {
            targetUsers = new Map();
            for (const [, m] of chosen) targetUsers.set(m.id, m.displayName);
          }
        }
        if (!targetUsers) {
          const pls = getPlList(guildId);
          if (pls.length > 0) targetCount = pls.length;
        }
      }

      const session = new ReadySession({
        guildId,
        title,
        startedBy: interaction.user.id,
        targetUsers,
        targetCount,
      });
      readySessions.set(guildId, session);

      const replyResponse = await interaction.reply({
        embeds: [session.buildEmbed(false)],
        components: [session.buildButtonRow(false)],
        withResponse: true,
      });
      session.message = replyResponse.resource.message;

      console.log(`[Ready] チェック「${title}」を開始しました（目標: ${session.targetCount ?? '自由'}名）`);
      return;
    }

    if (sub === 'cancel') {
      const session = readySessions.get(guildId);
      if (!session) {
        return interaction.reply({
          content: '❌ 現在進行中の読み込み完了チェックはありません。',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (session.startedBy !== interaction.user.id) {
        return interaction.reply({
          content: '❌ この操作はチェックを作成したGMのみ実行できます。',
          flags: MessageFlags.Ephemeral,
        });
      }

      session.isOpen = false;
      readySessions.delete(guildId);

      const cancelEmbed = new EmbedBuilder()
        .setTitle(`📖 ${session.title} — 中止`)
        .setColor(0x95A5A6)
        .setDescription('❌ 読み込み完了チェックはGMにより中止されました。')
        .setTimestamp();
      if (session.message) {
        await session.message.edit({ embeds: [cancelEmbed], components: [session.buildButtonRow(true)] }).catch(console.error);
      }
      return interaction.reply({
        content: '🗑️ 読み込み完了チェックを中止しました。',
        flags: MessageFlags.Ephemeral,
      });
    }
  },

  async handleButton(interaction) {
    const guildId = interaction.guildId;
    const readySession = readySessions.get(guildId);
    if (!readySession || !readySession.isOpen) {
      return interaction.reply({
        content: '❌ この読み込み完了チェックはすでに終了しています。',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === 'ready_finish') {
      if (readySession.startedBy !== interaction.user.id) {
        return interaction.reply({
          content: '❌ 締め切りはチェックを作成したGMのみ実行できます。',
          flags: MessageFlags.Ephemeral,
        });
      }
      readySession.isOpen = false;
      readySessions.delete(guildId);
      await interaction.update({
        embeds: [readySession.buildEmbed(true)],
        components: [readySession.buildButtonRow(true)],
      });
      playChimeIfConnected(guildId, 'notice.wav');
      await interaction.followUp({
        content: `🎉 **【準備完了】** 「**${readySession.title}**」を締め切りました！次のフェーズへ進みましょう！`,
      }).catch(() => {});
      return;
    }

    const displayName = interaction.member?.displayName || interaction.user.username;
    const isNowReady = readySession.toggleUser(interaction.user.id, displayName);

    if (readySession.isAllReady()) {
      readySession.isOpen = false;
      readySessions.delete(guildId);
      await interaction.update({
        embeds: [readySession.buildEmbed(true)],
        components: [readySession.buildButtonRow(true)],
      });
      playChimeIfConnected(guildId, 'notice.wav');
      await interaction.followUp({
        content: `🎉 **【全員完了！】** 「**${readySession.title}**」の読み込みが全員終わりました！次のフェーズへ進みましょう！`,
      }).catch(() => {});
      console.log(`[Ready] 「${readySession.title}」が全員完了しました。`);
    } else {
      await interaction.update({
        embeds: [readySession.buildEmbed(false)],
        components: [readySession.buildButtonRow(false)],
      });
      await interaction.followUp({
        content: isNowReady
          ? '✅ 読み込み完了として記録しました！'
          : '⏳ 読み込み完了を取り消しました。',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  },
};
