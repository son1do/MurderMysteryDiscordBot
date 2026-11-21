const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { getPlList } = require('../lib/state');
const { VOTE_NUMBERS } = require('../lib/utils');

const voteSessions = new Map();

class VoteSession {
  constructor({ guildId, title, options, startedBy }) {
    this.guildId = guildId;
    this.title = title;
    this.options = options;
    this.startedBy = startedBy;
    this.votes = new Map();
    this.message = null;
    this.isOpen = true;
  }

  castVote(userId, optionIndex) {
    const isChange = this.votes.has(userId);
    this.votes.set(userId, optionIndex);
    return isChange;
  }

  getTally() {
    const tally = this.options.map((opt, i) => ({ option: opt, index: i, count: 0 }));
    for (const [, idx] of this.votes) {
      if (tally[idx]) tally[idx].count++;
    }
    return tally;
  }

  buildEmbed(revealed = false) {
    const totalVotes = this.votes.size;
    const embed = new EmbedBuilder()
      .setTitle(`🗳️ ${this.title}`)
      .setTimestamp();

    if (!revealed) {
      const optionList = this.options
        .map((opt, i) => `${VOTE_NUMBERS[i] ?? `**${i + 1}.**`} ${opt}`)
        .join('\n');

      embed
        .setColor(0x3498DB)
        .setDescription(
          `下のボタンから投票先を選んでください。投票は**匿名**です。\n` +
          `別のボタンを押すと投票先を変更できます。\n\n` +
          `${optionList}\n\n` +
          `📊 現在の投票数: **${totalVotes}票**`
        )
        .setFooter({ text: 'GMが「結果を公開」するまで内訳は非表示です' });
    } else {
      const tally = this.getTally().sort((a, b) => b.count - a.count);
      const maxCount = Math.max(...tally.map(t => t.count), 0);
      const topWinners = maxCount > 0 ? tally.filter(t => t.count === maxCount) : [];
      const isTie = topWinners.length > 1;

      const BAR_LEN = 12;
      const resultsText = tally.map(t => {
        const pct = totalVotes > 0 ? Math.round((t.count / totalVotes) * 100) : 0;
        const filled = maxCount > 0 ? Math.round((t.count / maxCount) * BAR_LEN) : 0;
        const bar = '█'.repeat(filled) + '░'.repeat(BAR_LEN - filled);
        const crown = maxCount > 0 && t.count === maxCount ? ' 👑' : '';
        return `${VOTE_NUMBERS[t.index] ?? `**${t.index + 1}.**`} **${t.option}**${crown}\n\`${bar}\` **${t.count}票** (${pct}%)`;
      }).join('\n\n');

      const summaryLine = totalVotes === 0
        ? '\n\n⚠️ 投票がありませんでした。'
        : isTie
          ? `\n\n⚖️ **同票です！**（${topWinners.map(w => w.option).join(' / ')}）`
          : `\n\n🏆 最多得票: **${topWinners[0].option}**（${maxCount}票）`;

      embed
        .setColor(0xE74C3C)
        .setDescription(resultsText + summaryLine)
        .setFooter({ text: `合計 ${totalVotes}票 ｜ 投票締め切り済み` });
    }
    return embed;
  }

  buildButtonRows(disabled = false) {
    const rows = [];
    for (let i = 0; i < this.options.length; i += 5) {
      const slice = this.options.slice(i, i + 5);
      const row = new ActionRowBuilder();
      slice.forEach((opt, offset) => {
        const idx = i + offset;
        const btn = new ButtonBuilder()
          .setCustomId(`vote_opt_${idx}`)
          .setLabel(opt.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled);
        if (VOTE_NUMBERS[idx]) btn.setEmoji(VOTE_NUMBERS[idx]);
        row.addComponents(btn);
      });
      rows.push(row);
    }

    const gmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vote_peek')
        .setLabel('内訳を確認 (GM)')
        .setEmoji('👁️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('vote_reveal')
        .setLabel('結果を公開 (GM)')
        .setEmoji('📊')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('vote_cancel')
        .setLabel('投票を中止 (GM)')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    );
    rows.push(gmRow);
    return rows;
  }

  buildGmPreviewEmbed() {
    const totalVotes = this.votes.size;
    const tally = this.getTally().sort((a, b) => b.count - a.count);
    const maxCount = Math.max(...tally.map(t => t.count), 0);
    const BAR_LEN = 10;

    const tallyText = tally.map(t => {
      const pct = totalVotes > 0 ? Math.round((t.count / totalVotes) * 100) : 0;
      const filled = maxCount > 0 ? Math.round((t.count / maxCount) * BAR_LEN) : 0;
      const bar = '█'.repeat(filled) + '░'.repeat(BAR_LEN - filled);
      return `${VOTE_NUMBERS[t.index] ?? `**${t.index + 1}.**`} **${t.option}** — \`${bar}\` **${t.count}票** (${pct}%)`;
    }).join('\n');

    const detailLines = [...this.votes.entries()].map(
      ([userId, idx]) => `・<@${userId}> → **${this.options[idx]}**`
    );
    const detailText = detailLines.length > 0 ? detailLines.join('\n') : 'まだ投票がありません';

    return new EmbedBuilder()
      .setTitle(`👁️ 【GM専用プレビュー】${this.title}`)
      .setColor(0x9B59B6)
      .addFields(
        { name: `📊 現在の集計（計 ${totalVotes}票）`, value: tallyText },
        { name: '📝 投票内訳（誰が誰に入れたか）', value: detailText.slice(0, 1024) }
      )
      .setFooter({ text: 'このメッセージはGMにのみ表示されています（投票は継続中）' })
      .setTimestamp();
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('匿名投票を行います（ボタンで投票 → GMが公開）')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('匿名投票を開始します（選択肢省略時は /pl のPLリストを使用）')
        .addStringOption(opt =>
          opt.setName('title').setDescription('投票のタイトル（例: 犯人は誰？）。省略時は「犯人投票」').setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('options').setDescription('選択肢をカンマ区切りで指定（例: 田中,佐藤,鈴木）。省略時はPLリストを使用').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('result').setDescription('投票を締め切り、集計結果を公開します（作成者のみ）')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('現在の投票人数・投票済みメンバーを確認します（作成者のみ）')
    )
    .addSubcommand(sub =>
      sub.setName('cancel').setDescription('投票を結果非公開のまま中止します（作成者のみ）')
    ),
  buttonPrefixes: ['vote_'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'start') {
      if (voteSessions.has(guildId)) {
        return interaction.reply({
          content: '⚠️ すでに進行中の投票があります。先に `/vote result` または `/vote cancel` で終了してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const title = (interaction.options.getString('title') || '犯人投票').trim();
      const rawOptions = interaction.options.getString('options');

      let options;
      if (rawOptions) {
        options = rawOptions.split(/[,、，]/).map(s => s.trim()).filter(s => s.length > 0);
      } else {
        const pls = getPlList(guildId);
        if (pls.length < 2) {
          return interaction.reply({
            content: '❌ `options` を省略する場合は、先に `/pl add` または `/pl from-vc` でPLを2名以上登録してください。\nまたは `options:田中,佐藤,鈴木` のようにカンマ区切りで指定してください。',
            flags: MessageFlags.Ephemeral,
          });
        }
        options = [...pls];
      }

      if (options.length < 2) {
        return interaction.reply({
          content: '❌ 選択肢は2つ以上指定してください。（例: `田中,佐藤,鈴木`）',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (options.length > 20) {
        return interaction.reply({
          content: '❌ 選択肢は最大20個までです。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const session = new VoteSession({
        guildId,
        title,
        options,
        startedBy: interaction.user.id,
      });
      voteSessions.set(guildId, session);

      const replyResponse = await interaction.reply({
        embeds: [session.buildEmbed(false)],
        components: session.buildButtonRows(false),
        withResponse: true,
      });
      session.message = replyResponse.resource.message;

      console.log(`[Vote] 投票「${title}」を開始しました（${options.length}択）`);
      return;
    }

    const session = voteSessions.get(guildId);
    if (!session) {
      return interaction.reply({
        content: '❌ 現在進行中の投票はありません。',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (session.startedBy !== interaction.user.id) {
      return interaction.reply({
        content: '❌ この操作は投票を作成したGMのみ実行できます。',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'status') {
      return interaction.reply({
        embeds: [session.buildGmPreviewEmbed()],
        flags: MessageFlags.Ephemeral,
      });
    }

    session.isOpen = false;
    voteSessions.delete(guildId);

    if (sub === 'result') {
      const resultEmbed = session.buildEmbed(true);
      const disabledRows = session.buildButtonRows(true);
      if (session.message) {
        await session.message.edit({ embeds: [resultEmbed], components: disabledRows }).catch(console.error);
      }
      console.log(`[Vote] 投票「${session.title}」の結果を公開しました。`);
      return interaction.reply({
        content: `📊 **【投票結果公開】** 「${session.title}」を締め切りました！`,
        embeds: [resultEmbed],
      });
    }

    if (sub === 'cancel') {
      const cancelEmbed = new EmbedBuilder()
        .setTitle(`🗳️ ${session.title} - 中止`)
        .setColor(0x95A5A6)
        .setDescription('❌ この投票はGMにより中止されました。')
        .setTimestamp();
      if (session.message) {
        await session.message.edit({ embeds: [cancelEmbed], components: session.buildButtonRows(true) }).catch(console.error);
      }
      console.log(`[Vote] 投票「${session.title}」を中止しました。`);
      return interaction.reply({
        content: '🗑️ 投票を中止しました。',
        flags: MessageFlags.Ephemeral,
      });
    }
  },

  async handleButton(interaction) {
    const guildId = interaction.guildId;
    const voteSession = voteSessions.get(guildId);
    if (!voteSession || !voteSession.isOpen) {
      return interaction.reply({
        content: '❌ この投票はすでに終了しています。',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId.startsWith('vote_opt_')) {
      const idx = parseInt(interaction.customId.replace('vote_opt_', ''), 10);
      const optionName = voteSession.options[idx];
      if (optionName === undefined) {
        return interaction.reply({
          content: '❌ 無効な選択肢です。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const isChange = voteSession.castVote(interaction.user.id, idx);
      if (voteSession.message) {
        voteSession.message.edit({ embeds: [voteSession.buildEmbed(false)] }).catch(() => {});
      }

      return interaction.reply({
        content: isChange
          ? `🔄 投票先を **${optionName}** に変更しました！（匿名・再変更可）`
          : `✅ **${optionName}** に投票しました！（匿名・別ボタンで変更可）`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === 'vote_peek') {
      if (voteSession.startedBy !== interaction.user.id) {
        return interaction.reply({
          content: '❌ 内訳の確認は投票を作成したGMのみ実行できます。',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        embeds: [voteSession.buildGmPreviewEmbed()],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === 'vote_reveal' || interaction.customId === 'vote_cancel') {
      if (voteSession.startedBy !== interaction.user.id) {
        return interaction.reply({
          content: '❌ この操作は投票を作成したGMのみ実行できます。',
          flags: MessageFlags.Ephemeral,
        });
      }

      voteSession.isOpen = false;
      voteSessions.delete(guildId);

      if (interaction.customId === 'vote_reveal') {
        const resultEmbed = voteSession.buildEmbed(true);
        const disabledRows = voteSession.buildButtonRows(true);
        await interaction.update({ embeds: [resultEmbed], components: disabledRows });
        await interaction.followUp({
          content: `📊 **【投票結果公開】** 「${voteSession.title}」の集計結果が公開されました！`,
        }).catch(() => {});
        console.log(`[Vote] 投票「${voteSession.title}」の結果を公開しました。`);
      } else {
        const cancelEmbed = new EmbedBuilder()
          .setTitle(`🗳️ ${voteSession.title} - 中止`)
          .setColor(0x95A5A6)
          .setDescription('❌ この投票はGMにより中止されました。')
          .setTimestamp();
        await interaction.update({ embeds: [cancelEmbed], components: voteSession.buildButtonRows(true) });
        console.log(`[Vote] 投票「${voteSession.title}」を中止しました。`);
      }
    }
  },
};
