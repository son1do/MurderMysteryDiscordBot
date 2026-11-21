const path = require('path');
const fs = require('fs');
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const {
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const { activeTimers } = require('../lib/state');
const { parseDuration, formatTime, createProgressBar } = require('../lib/utils');
const { SOUNDS_DIR, connectToVoice } = require('../lib/voice');

function buildTimerEmbed(session) {
  const percent = session.totalSeconds > 0
    ? Math.round((session.remainingSeconds / session.totalSeconds) * 100)
    : 0;
  const progressBar = createProgressBar(session.remainingSeconds, session.totalSeconds);
  const statusEmoji = session.isPaused ? '⏸️ 一時停止中' : '🟢 進行中';

  return new EmbedBuilder()
    .setTitle(`⏱️ ${session.title || 'マダミス議論タイマー'}`)
    .setColor(session.isPaused ? 0xE67E22 : (session.remainingSeconds <= 60 ? 0xE74C3C : 0x2ECC71))
    .addFields(
      {
        name: '⏳ 残り時間',
        value: `### \` ${formatTime(session.remainingSeconds)} \` (${percent}%)`,
        inline: true,
      },
      {
        name: '📊 状態',
        value: statusEmoji,
        inline: true,
      },
      {
        name: '🔊 ボイス通知',
        value: session.voiceConnection ? '接続中' : '⚠️ 未接続 (チャイム無効)',
        inline: true,
      },
      {
        name: '進行バー',
        value: `${progressBar}`,
        inline: false,
      }
    )
    .setFooter({ text: 'ボタン操作で一時停止、再開、時間の追加が可能です' })
    .setTimestamp();
}

function buildButtonRow(isPaused) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('timer_toggle_pause')
      .setLabel(isPaused ? '再開 (Resume)' : '一時停止 (Pause)')
      .setEmoji(isPaused ? '▶️' : '⏸️')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('timer_add_1m')
      .setLabel('+1分')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('timer_add_3m')
      .setLabel('+3分')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('timer_add_5m')
      .setLabel('+5分')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('timer_stop')
      .setLabel('終了')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
  );
}

class TimerSession {
  constructor({ guildId, textChannel, voiceConnection, totalSeconds, title }) {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.voiceConnection = voiceConnection;
    this.totalSeconds = totalSeconds;
    this.remainingSeconds = totalSeconds;
    this.title = title || '議論フェーズ';
    this.isPaused = false;
    this.message = null;
    this.timerInterval = null;
    this.lastEditTime = 0;

    this.player = createAudioPlayer();
    this.player.on('error', error => {
      console.error('[AudioPlayer Error]', error.message);
    });

    if (this.voiceConnection) {
      this.voiceConnection.subscribe(this.player);
    }

    this.notified5m = totalSeconds <= 300;
    this.notified1m = totalSeconds <= 60;
  }

  playChime(soundFileName) {
    if (!this.voiceConnection) return;
    const soundPath = path.join(SOUNDS_DIR, soundFileName);
    if (!fs.existsSync(soundPath)) {
      console.warn(`[playChime] 音声ファイルが見つかりません: ${soundPath}`);
      return;
    }

    try {
      const resource = createAudioResource(soundPath, { inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(1.0);
      this.player.play(resource);
      console.log(`[Audio] チャイム音「${soundFileName}」を再生しました。`);
    } catch (error) {
      console.error('[playChime Error]', error);
    }
  }

  async start(interaction) {
    const embed = buildTimerEmbed(this);
    const row = buildButtonRow(this.isPaused);

    this.message = await interaction.editReply({
      embeds: [embed],
      components: [row],
    });

    this.timerInterval = setInterval(() => this.tick(), 1000);
  }

  async tick() {
    if (this.isPaused) return;

    this.remainingSeconds -= 1;

    if (!this.notified5m && this.remainingSeconds <= 300 && this.remainingSeconds > 290) {
      this.notified5m = true;
      this.textChannel.send({
        content: '🔔 **【残り5分】** 議論のまとめや最終的な確認を始めてください！',
      }).catch(console.error);
      this.playChime('notice.wav');
    }

    if (!this.notified1m && this.remainingSeconds <= 60 && this.remainingSeconds > 50) {
      this.notified1m = true;
      this.textChannel.send({
        content: '⚠️ **【残り1分】** まもなく議論時間終了です！発言をまとめてください！',
      }).catch(console.error);
      this.playChime('notice.wav');
    }

    if (this.remainingSeconds <= 0) {
      await this.finish();
      return;
    }

    const now = Date.now();
    if (now - this.lastEditTime >= 5000) {
      this.lastEditTime = now;
      this.updateMessage().catch(console.error);
    }
  }

  async togglePause() {
    this.isPaused = !this.isPaused;
    await this.updateMessage();
    return this.isPaused;
  }

  async addSeconds(seconds) {
    this.remainingSeconds += seconds;
    if (this.remainingSeconds > this.totalSeconds) {
      this.totalSeconds = this.remainingSeconds;
    }
    if (this.remainingSeconds > 300) this.notified5m = false;
    if (this.remainingSeconds > 60) this.notified1m = false;

    await this.updateMessage();
  }

  async updateMessage() {
    if (!this.message) return;
    try {
      await this.message.edit({
        embeds: [buildTimerEmbed(this)],
        components: [buildButtonRow(this.isPaused)],
      });
    } catch (e) {
      console.error('Failed to edit timer message:', e.message);
    }
  }

  async finish(manual = false) {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    activeTimers.delete(this.guildId);

    const embed = new EmbedBuilder()
      .setTitle(`⏱️ ${this.title} - ${manual ? '中断されました' : '終了'}`)
      .setColor(manual ? 0x95A5A6 : 0xE74C3C)
      .setDescription(manual ? '⏹️ タイマーが手動で終了されました。' : '🚨 **時間が終了しました！議論をストップしてください。**')
      .setTimestamp();

    if (this.message) {
      await this.message.edit({ embeds: [embed], components: [] }).catch(console.error);
    }

    if (!manual) {
      const voiceChannelId = this.voiceConnection?.joinConfig?.channelId;
      const gatherRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(voiceChannelId ? `vc_gather_${voiceChannelId}` : 'vc_gather_caller')
          .setLabel('全員をこのVCに集合させる')
          .setEmoji('📢')
          .setStyle(ButtonStyle.Primary)
      );

      this.textChannel.send({
        content: `🚨 **【時間終了】** 「**${this.title}**」が終了しました！マイクをミュートにするか、次の指示に従ってください。`,
        components: [gatherRow],
      }).catch(console.error);
      this.playChime('finish.wav');
    }
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timer')
    .setDescription('マダミス用タイマーを操作します')
    .addSubcommand(sub =>
      sub.setName('connect').setDescription('あなたが現在いるボイスチャンネルにBotを接続させます')
    )
    .addSubcommand(sub =>
      sub.setName('disconnect').setDescription('ボイスチャンネルからBotを切断（退出）させます')
    )
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('タイマーを開始します')
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription('時間（例: 15, 15m, 10:00, 90s）。数字だけの場合は「分」')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('title')
            .setDescription('フェーズ名やタイトル（例: 全体議論①、密談フェーズ）')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('実行中のタイマーを停止します')
    )
    .addSubcommand(sub =>
      sub
        .setName('test')
        .setDescription('ボイスチャンネルでのチャイム音テストを行います')
        .addStringOption(opt =>
          opt
            .setName('type')
            .setDescription('テストする音の種類')
            .setRequired(false)
            .addChoices(
              { name: '残り時間チャイム (ピンポーン)', value: 'notice.wav' },
              { name: '終了アラーム (ピピピッ)', value: 'finish.wav' }
            )
        )
    ),
  buttonPrefixes: ['timer_'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'connect') {
      const memberVoice = interaction.member.voice;
      if (!memberVoice || !memberVoice.channel) {
        return interaction.reply({
          content: '❌ あなたがボイスチャンネル（VC）に接続していません。VCに入ってから実行してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();
      try {
        await connectToVoice(memberVoice.channel, interaction.guild);
        return interaction.editReply({
          content: `✅ ボイスチャンネル「**${memberVoice.channel.name}**」に接続しました！このままタイマーを開始できます。`,
        });
      } catch (err) {
        console.error('[Connect Error]', err.message);
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

    if (sub === 'disconnect') {
      const connection = getVoiceConnection(guildId);
      if (!connection) {
        return interaction.reply({
          content: 'ボイスチャンネルに接続していません。',
          flags: MessageFlags.Ephemeral,
        });
      }
      connection.destroy();
      console.log('[Voice] ボイスチャンネルから退出しました。');
      return interaction.reply({ content: '👋 ボイスチャンネルから退出しました。' });
    }

    if (sub === 'test') {
      const memberVoice = interaction.member.voice;
      if (!memberVoice || !memberVoice.channel) {
        return interaction.reply({
          content: '❌ あなたがボイスチャンネル（VC）に接続していません。VCに入ってから実行してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const soundFile = interaction.options.getString('type') || 'notice.wav';
      const soundPath = path.join(SOUNDS_DIR, soundFile);

      try {
        const connection = await connectToVoice(memberVoice.channel, interaction.guild);
        const player = createAudioPlayer();
        player.on('error', err => console.error('[Test Player Error]', err.message));

        const resource = createAudioResource(soundPath, { inlineVolume: true });
        if (resource.volume) resource.volume.setVolume(1.0);

        connection.subscribe(player);
        player.play(resource);
        console.log(`[Audio] テスト音「${soundFile}」を再生しました。`);

        return interaction.editReply({
          content: `🔊 ボイスチャンネル「**${memberVoice.channel.name}**」でテスト音（\`${soundFile}\`）を再生しました！`,
        });
      } catch (err) {
        console.error('[Test Error]', err.message);
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

    if (sub === 'start') {
      const timeInput = interaction.options.getString('time');
      const title = interaction.options.getString('title') || 'マダミス議論フェーズ';
      const seconds = parseDuration(timeInput);

      if (!seconds || seconds <= 0) {
        return interaction.reply({
          content: '❌ 時間の指定形式が正しくありません。（例: `15` = 15分, `10m` = 10分, `90s` = 90秒）',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (activeTimers.has(guildId)) {
        return interaction.reply({
          content: '⚠️ すでに実行中のタイマーがあります。終了させるかボタンから操作してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      let connection = getVoiceConnection(guildId);
      let vcWarning = '';
      const memberVoice = interaction.member.voice;

      if (connection && connection.state.status === VoiceConnectionStatus.Ready) {
        console.log('[Timer] 既存のボイス接続を使用します。');
      } else if (memberVoice && memberVoice.channel) {
        try {
          connection = await connectToVoice(memberVoice.channel, interaction.guild);
        } catch (err) {
          console.warn('[Timer] ボイスチャンネル接続失敗:', err.message);
          connection = null;
          vcWarning = `\n⚠️ ボイスチャンネルへの接続に失敗しました（${err.message}）。チャイム音なしでタイマーを開始します。`;
        }
      } else {
        vcWarning = '\n💡 *コマンド実行者がボイスチャンネルに未接続のため、チャイム音なし（テキスト通知のみ）で動作します。*';
      }

      const session = new TimerSession({
        guildId,
        textChannel: interaction.channel,
        voiceConnection: connection,
        totalSeconds: seconds,
        title,
      });

      activeTimers.set(guildId, session);
      await session.start(interaction);

      if (vcWarning) {
        interaction.followUp({ content: vcWarning, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

    if (sub === 'stop') {
      const session = activeTimers.get(guildId);
      if (!session) {
        return interaction.reply({
          content: '❌ 現在実行中のタイマーはありません。',
          flags: MessageFlags.Ephemeral,
        });
      }
      await session.finish(true);
      return interaction.reply({
        content: '⏹️ タイマーを停止しました。',
        flags: MessageFlags.Ephemeral,
      });
    }
  },

  async handleButton(interaction) {
    const session = activeTimers.get(interaction.guildId);
    if (!session) {
      return interaction.reply({
        content: 'このタイマーは既に終了しています。',
        flags: MessageFlags.Ephemeral,
      });
    }

    switch (interaction.customId) {
      case 'timer_toggle_pause': {
        const isPaused = await session.togglePause();
        return interaction.reply({
          content: isPaused ? '⏸️ タイマーを一時停止しました。' : '▶️ タイマーを再開しました。',
          flags: MessageFlags.Ephemeral,
        });
      }
      case 'timer_add_1m': {
        await session.addSeconds(60);
        return interaction.reply({
          content: '➕ 時間を 1分 追加しました。',
          flags: MessageFlags.Ephemeral,
        });
      }
      case 'timer_add_3m': {
        await session.addSeconds(180);
        return interaction.reply({
          content: '➕ 時間を 3分 追加しました。',
          flags: MessageFlags.Ephemeral,
        });
      }
      case 'timer_add_5m': {
        await session.addSeconds(300);
        return interaction.reply({
          content: '➕ 時間を 5分 追加しました。',
          flags: MessageFlags.Ephemeral,
        });
      }
      case 'timer_stop': {
        await session.finish(true);
        return interaction.reply({
          content: '⏹️ タイマーを終了しました。',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};
