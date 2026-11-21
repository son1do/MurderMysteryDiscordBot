const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { getPlList } = require('../lib/state');
const { parseDuration, formatTime, createProgressBar, shuffleArray } = require('../lib/utils');
const { connectToVoice, playChimeIfConnected } = require('../lib/voice');

const activeTurns = new Map();

class TurnSession {
  constructor({ guildId, textChannel, voiceConnection, secondsPerTurn, title, order }) {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.voiceConnection = voiceConnection;
    this.secondsPerTurn = secondsPerTurn;
    this.remainingSeconds = secondsPerTurn;
    this.title = title || '最終弁論';
    this.order = order;
    this.currentIndex = 0;
    this.isPaused = false;
    this.isTimeUp = false;
    this.message = null;
    this.timerInterval = null;
    this.lastEditTime = 0;
  }

  get currentSpeaker() {
    return this.order[this.currentIndex];
  }

  get isLastSpeaker() {
    return this.currentIndex >= this.order.length - 1;
  }

  buildEmbed() {
    const speaker = this.currentSpeaker;
    const progressBar = createProgressBar(this.remainingSeconds, this.secondsPerTurn, 10);
    const statusText = this.isTimeUp
      ? '⏰ 時間終了（次へ待機中）'
      : this.isPaused
        ? '⏸️ 一時停止中'
        : '🟢 発言中';

    const orderLines = this.order.map((name, i) => {
      if (i < this.currentIndex) return `✅ ~~${name}~~`;
      if (i === this.currentIndex) return `▶️ **${name}** ⬅️ いまここ`;
      return `⏳ ${name}`;
    }).join('\n');

    const color = this.isTimeUp
      ? 0xE74C3C
      : this.isPaused
        ? 0xE67E22
        : (this.remainingSeconds <= 15 ? 0xE74C3C : 0x2ECC71);

    return new EmbedBuilder()
      .setTitle(`🎤 ${this.title}（${this.currentIndex + 1} / ${this.order.length}人目）`)
      .setColor(color)
      .setDescription(`## 🗣️ ${speaker} さんの番`)
      .addFields(
        { name: '⏳ 残り時間', value: `### \` ${formatTime(this.remainingSeconds)} \``, inline: true },
        { name: '📊 状態', value: statusText, inline: true },
        { name: '進行バー', value: progressBar, inline: false },
        { name: '📋 発言順', value: orderLines.slice(0, 1024), inline: false }
      )
      .setFooter({ text: '話し終わったら「⏭️ 次の人へ」ボタンで次の人にバトンタッチできます' })
      .setTimestamp();
  }

  buildButtonRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('turn_next')
        .setLabel(this.isLastSpeaker ? '全員終了' : '次の人へ')
        .setEmoji(this.isLastSpeaker ? '🏁' : '⏭️')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('turn_toggle_pause')
        .setLabel(this.isPaused ? '再開' : '一時停止')
        .setEmoji(this.isPaused ? '▶️' : '⏸️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(this.isTimeUp),
      new ButtonBuilder()
        .setCustomId('turn_add_30s')
        .setLabel('+30秒')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('turn_stop')
        .setLabel('中断')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger)
    );
  }

  async start(interaction) {
    this.message = await interaction.editReply({
      embeds: [this.buildEmbed()],
      components: [this.buildButtonRow()],
    });
    playChimeIfConnected(this.guildId, 'notice.wav');
    this.timerInterval = setInterval(() => this.tick(), 1000);
  }

  async tick() {
    if (this.isPaused || this.isTimeUp) return;

    this.remainingSeconds -= 1;

    if (this.remainingSeconds <= 0) {
      this.remainingSeconds = 0;
      this.isTimeUp = true;
      playChimeIfConnected(this.guildId, 'finish.wav');
      await this.updateMessage();

      if (this.isLastSpeaker) {
        await this.finish(false);
      } else {
        const nextSpeaker = this.order[this.currentIndex + 1];
        this.textChannel.send({
          content: `⏰ **【時間終了】** **${this.currentSpeaker}** さんの持ち時間が終了しました！準備ができたら **「⏭️ 次の人へ」** で **${nextSpeaker}** さんに進んでください。`,
        }).catch(console.error);
      }
      return;
    }

    const now = Date.now();
    if (now - this.lastEditTime >= 5000) {
      this.lastEditTime = now;
      this.updateMessage().catch(console.error);
    }
  }

  async nextTurn() {
    if (this.isLastSpeaker) {
      await this.finish(false);
      return { finished: true };
    }
    this.currentIndex += 1;
    this.remainingSeconds = this.secondsPerTurn;
    this.isPaused = false;
    this.isTimeUp = false;
    this.lastEditTime = Date.now();
    playChimeIfConnected(this.guildId, 'notice.wav');
    await this.updateMessage();
    return { finished: false, speaker: this.currentSpeaker };
  }

  async togglePause() {
    this.isPaused = !this.isPaused;
    await this.updateMessage();
    return this.isPaused;
  }

  async addSeconds(sec) {
    this.remainingSeconds += sec;
    if (this.isTimeUp && this.remainingSeconds > 0) {
      this.isTimeUp = false;
      this.isPaused = false;
    }
    await this.updateMessage();
  }

  async updateMessage() {
    if (!this.message) return;
    try {
      await this.message.edit({
        embeds: [this.buildEmbed()],
        components: [this.buildButtonRow()],
      });
    } catch (e) {
      console.error('[Turn] メッセージ更新エラー:', e.message);
    }
  }

  async finish(manual = false) {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    activeTurns.delete(this.guildId);

    const doneEmbed = new EmbedBuilder()
      .setTitle(`🎤 ${this.title} — ${manual ? '中断されました' : '全員終了！'}`)
      .setColor(manual ? 0x95A5A6 : 0x2ECC71)
      .setDescription(
        manual
          ? '⏹️ リレータイマーが手動で中断されました。'
          : `🎉 全 **${this.order.length}名** の発言が終了しました！お疲れ様でした！`
      )
      .setTimestamp();

    if (this.message) {
      await this.message.edit({ embeds: [doneEmbed], components: [] }).catch(console.error);
    }

    if (!manual) {
      this.textChannel.send({
        content: `🏁 **【${this.title} 完了】** 全員の発言が終了しました！`,
      }).catch(console.error);
    }
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('turn')
    .setDescription('1人ずつ順番に持ち時間を計測するリレータイマー（最終弁論・自己紹介など）')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('リレータイマーを開始します')
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription('1人あたりの時間（例: 60s, 1m, 2, 90s）。数字だけの場合は「分」')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('title')
            .setDescription('タイトル（例: 最終弁論、自己紹介、アリバイ発表）')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('shuffle')
            .setDescription('発言順をランダムにシャッフルするか（デフォルト: False）')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName('members')
            .setDescription('発言者をカンマ区切りで指定（省略時は /pl リストまたはVCメンバーを使用）')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('実行中のリレータイマーを中断します')
    ),
  buttonPrefixes: ['turn_'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'start') {
      if (activeTurns.has(guildId)) {
        return interaction.reply({
          content: '⚠️ すでに実行中のリレータイマーがあります。終了させるか `/turn stop` で中断してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const timeInput = interaction.options.getString('time');
      const secondsPerTurn = parseDuration(timeInput);
      if (!secondsPerTurn || secondsPerTurn <= 0) {
        return interaction.reply({
          content: '❌ 時間の指定形式が正しくありません。（例: `60s`, `1m`, `90s`, `2`）',
          flags: MessageFlags.Ephemeral,
        });
      }

      const title = (interaction.options.getString('title') || '最終弁論').trim();
      const shouldShuffle = interaction.options.getBoolean('shuffle') ?? false;
      const rawMembers = interaction.options.getString('members');

      let order = [];
      if (rawMembers) {
        order = rawMembers.split(/[,、，]/).map(s => s.trim()).filter(s => s.length > 0);
      } else {
        const pls = getPlList(guildId);
        if (pls.length > 0) {
          order = [...pls];
        } else if (interaction.member.voice?.channel) {
          const humans = interaction.member.voice.channel.members.filter(m => !m.user.bot);
          const withoutGm = humans.filter(m => m.id !== interaction.user.id);
          const chosen = withoutGm.size > 0 ? withoutGm : humans;
          order = chosen.map(m => m.displayName);
        }
      }

      if (order.length === 0) {
        return interaction.reply({
          content: '❌ 発言者が見つかりません。`/pl add` / `/pl from-vc` でPLを登録するか、`members` オプションで指定してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (shouldShuffle) order = shuffleArray(order);

      await interaction.deferReply();

      let connection = getVoiceConnection(guildId);
      const memberVoice = interaction.member.voice;
      if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
        if (memberVoice?.channel) {
          try {
            connection = await connectToVoice(memberVoice.channel, interaction.guild);
          } catch (err) {
            console.warn('[Turn] VC接続失敗:', err.message);
            connection = null;
          }
        }
      }

      const session = new TurnSession({
        guildId,
        textChannel: interaction.channel,
        voiceConnection: connection,
        secondsPerTurn,
        title,
        order,
      });
      activeTurns.set(guildId, session);
      await session.start(interaction);
      console.log(`[Turn] リレータイマー「${title}」を開始しました（${order.length}名 / 各${secondsPerTurn}秒）`);
      return;
    }

    if (sub === 'stop') {
      const session = activeTurns.get(guildId);
      if (!session) {
        return interaction.reply({
          content: '❌ 現在実行中のリレータイマーはありません。',
          flags: MessageFlags.Ephemeral,
        });
      }
      await session.finish(true);
      return interaction.reply({
        content: '⏹️ リレータイマーを中断しました。',
        flags: MessageFlags.Ephemeral,
      });
    }
  },

  async handleButton(interaction) {
    const turnSession = activeTurns.get(interaction.guildId);
    if (!turnSession) {
      return interaction.reply({
        content: '❌ このリレータイマーはすでに終了しています。',
        flags: MessageFlags.Ephemeral,
      });
    }

    switch (interaction.customId) {
      case 'turn_next': {
        const res = await turnSession.nextTurn();
        if (res.finished) {
          return interaction.reply({ content: '🏁 全員の発言を終了しました！', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `⏭️ 次は **${res.speaker}** さんの番です！` });
      }
      case 'turn_toggle_pause': {
        const paused = await turnSession.togglePause();
        return interaction.reply({
          content: paused ? '⏸️ リレータイマーを一時停止しました。' : '▶️ リレータイマーを再開しました。',
          flags: MessageFlags.Ephemeral,
        });
      }
      case 'turn_add_30s': {
        await turnSession.addSeconds(30);
        return interaction.reply({ content: '➕ 持ち時間を 30秒 追加しました。', flags: MessageFlags.Ephemeral });
      }
      case 'turn_stop': {
        await turnSession.finish(true);
        return interaction.reply({ content: '⏹️ リレータイマーを中断しました。', flags: MessageFlags.Ephemeral });
      }
    }
  },
};
