require('dotenv').config();
const path = require('path');
const fs = require('fs');

// ffmpeg-static のパスを設定
try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
  }
} catch (e) {
  // ffmpeg-static がない場合はシステムPATHのffmpegを使用
}

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// サーバーごとのタイマーセッション管理: Map<guildId, TimerSession>
const activeTimers = new Map();

/**
 * 時間文字列 (例: "15m", "15", "1h30m", "90s") を秒数に変換
 */
function parseDuration(input) {
  if (!input) return null;
  const str = input.toString().trim().toLowerCase();

  // 単なる数字なら「分」として扱う (例: "15" -> 15分)
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10) * 60;
  }

  let totalSeconds = 0;
  const hourMatch = str.match(/(\d+)\s*h/);
  const minMatch = str.match(/(\d+)\s*m/);
  const secMatch = str.match(/(\d+)\s*s/);

  if (hourMatch) totalSeconds += parseInt(hourMatch[1], 10) * 3600;
  if (minMatch) totalSeconds += parseInt(minMatch[1], 10) * 60;
  if (secMatch) totalSeconds += parseInt(secMatch[1], 10);

  return totalSeconds > 0 ? totalSeconds : null;
}

/**
 * 秒数を MM:SS または HH:MM:SS にフォーマット
 */
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * プログレスバー生成
 */
function createProgressBar(remaining, total, length = 12) {
  if (total <= 0) return '⬜'.repeat(length);
  const progress = Math.min(1, Math.max(0, remaining / total));
  const filledCount = Math.round(progress * length);
  const emptyCount = length - filledCount;
  return '🟩'.repeat(filledCount) + '⬜'.repeat(emptyCount);
}

/**
 * タイマーEmbed作成
 */
function buildTimerEmbed(session) {
  const percent = session.totalSeconds > 0 
    ? Math.round((session.remainingSeconds / session.totalSeconds) * 100) 
    : 0;
  const progressBar = createProgressBar(session.remainingSeconds, session.totalSeconds);
  const statusEmoji = session.isPaused ? '⏸️ 一時停止中' : '🟢 進行中';

  const embed = new EmbedBuilder()
    .setTitle(`⏱️ ${session.title || 'マダミス議論タイマー'}`)
    .setColor(session.isPaused ? 0xE67E22 : (session.remainingSeconds <= 60 ? 0xE74C3C : 0x2ECC71))
    .addFields(
      {
        name: '⏳ 残り時間',
        value: `### \` ${formatTime(session.remainingSeconds)} \` (${percent}%)`,
        inline: true
      },
      {
        name: '📊 状態',
        value: statusEmoji,
        inline: true
      },
      {
        name: '🔊 ボイス通知',
        value: session.voiceConnection ? '接続中' : '⚠️ 未接続 (チャイム無効)',
        inline: true
      },
      {
        name: '進行バー',
        value: `${progressBar}`,
        inline: false
      }
    )
    .setFooter({ text: 'ボタン操作で一時停止、再開、時間の追加が可能です' })
    .setTimestamp();

  return embed;
}

/**
 * 操作ボタンRow作成
 */
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

/**
 * タイマーセッションクラス
 */
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

    // AudioPlayer の初期化
    this.player = createAudioPlayer();
    this.player.on('error', error => {
      console.error('[AudioPlayer Error]', error.message);
    });
    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log('[AudioPlayer] Playing chime sound.');
    });

    if (this.voiceConnection) {
      this.voiceConnection.subscribe(this.player);
    }

    // 重複通知防止フラグ
    this.notified5m = totalSeconds <= 300; // 最初から5分以下の場合は通知スキップ
    this.notified1m = totalSeconds <= 60;  // 最初から1分以下の場合は通知スキップ
  }

  playChime(soundFileName) {
    if (!this.voiceConnection) return;
    const soundPath = path.join(__dirname, 'sounds', soundFileName);
    if (!fs.existsSync(soundPath)) {
      console.warn(`[playChime] Sound file not found: ${soundPath}`);
      return;
    }

    try {
      const resource = createAudioResource(soundPath, { inlineVolume: true });
      if (resource.volume) {
        resource.volume.setVolume(1.0);
      }
      this.player.play(resource);
      console.log(`[playChime] Dispatched ${soundFileName}`);
    } catch (error) {
      console.error('[playChime] Failed to play chime:', error);
    }
  }

  async start(interaction) {
    const embed = buildTimerEmbed(this);
    const row = buildButtonRow(this.isPaused);

    this.message = await interaction.editReply({
      embeds: [embed],
      components: [row]
    });

    // 1秒ごとにカウントダウン計算、5秒ごとにDiscord Embedを編集
    this.timerInterval = setInterval(() => this.tick(), 1000);
  }

  async tick() {
    if (this.isPaused) return;

    this.remainingSeconds -= 1;

    // 残り5分アナウンス
    if (!this.notified5m && this.remainingSeconds <= 300 && this.remainingSeconds > 290) {
      this.notified5m = true;
      this.textChannel.send({
        content: `🔔 **【残り5分】** 議論のまとめや最終的な確認を始めてください！`
      }).catch(console.error);
      this.playChime('notice.wav');
    }

    // 残り1分アナウンス
    if (!this.notified1m && this.remainingSeconds <= 60 && this.remainingSeconds > 50) {
      this.notified1m = true;
      this.textChannel.send({
        content: `⚠️ **【残り1分】** まもなく議論時間終了です！発言をまとめてください！`
      }).catch(console.error);
      this.playChime('notice.wav');
    }

    // 時間終了
    if (this.remainingSeconds <= 0) {
      await this.finish();
      return;
    }

    // Rate Limit回避のため、5秒おきにメッセージを編集
    const now = Date.now();
    if (now - this.lastEditTime >= 5000) {
      this.lastEditTime = now;
      this.updateMessage().catch(console.error);
    }
  }

  async togglePause() {
    this.isPaused = !this.isPaused;
    await this.updateMessage(true);
    return this.isPaused;
  }

  async addSeconds(seconds) {
    this.remainingSeconds += seconds;
    if (this.remainingSeconds > this.totalSeconds) {
      this.totalSeconds = this.remainingSeconds;
    }
    // 巻き戻した場合は再通知できるようにリセット
    if (this.remainingSeconds > 300) this.notified5m = false;
    if (this.remainingSeconds > 60) this.notified1m = false;

    await this.updateMessage(true);
  }

  async updateMessage(force = false) {
    if (!this.message) return;
    try {
      const embed = buildTimerEmbed(this);
      const row = buildButtonRow(this.isPaused);
      await this.message.edit({ embeds: [embed], components: [row] });
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
      this.textChannel.send({
        content: `🚨 **【時間終了】** 議論フェーズが終了しました！マイクをミュートにするか、次の指示に従ってください。`
      }).catch(console.error);
      this.playChime('finish.wav');
    }

    // VCから切断 (音が鳴り終わるのを待ってから)
    setTimeout(() => {
      if (this.voiceConnection && this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
        console.log('[VoiceConnection] Disconnecting from voice channel.');
        this.voiceConnection.destroy();
      }
    }, 4500);
  }
}

// スラッシュコマンド定義
const commands = [
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('マダミス用タイマーを操作します')
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
      sub
        .setName('stop')
        .setDescription('実行中のタイマーを停止します')
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
    )
];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const guildId = process.env.GUILD_ID;
  if (guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      await guild.commands.set(commands);
      console.log(`Commands registered to guild: ${guild.name} (${guildId})`);
    } else {
      console.warn(`Guild with ID ${guildId} not found, registering globally.`);
      await client.application.commands.set(commands);
    }
  } else {
    await client.application.commands.set(commands);
    console.log('Commands registered globally.');
  }
});

// スラッシュコマンド処理
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== 'timer') return;

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // 1. テストコマンド (/timer test)
    if (sub === 'test') {
      const memberVoice = interaction.member.voice;
      if (!memberVoice || !memberVoice.channel) {
        return interaction.reply({
          content: '❌ あなたがボイスチャンネル（VC）に接続していません。VCに入ってから実行してください。',
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const soundFile = interaction.options.getString('type') || 'notice.wav';
      const soundPath = path.join(__dirname, 'sounds', soundFile);

      try {
        console.log(`[Test] Connecting to VC: ${memberVoice.channel.name}`);
        const connection = joinVoiceChannel({
          channelId: memberVoice.channel.id,
          guildId: interaction.guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 7000);
        console.log('[Test] VC Connected and Ready. Playing sound...');

        const player = createAudioPlayer();
        const resource = createAudioResource(soundPath, { inlineVolume: true });
        if (resource.volume) resource.volume.setVolume(1.0);

        connection.subscribe(player);
        player.play(resource);

        player.on(AudioPlayerStatus.Idle, () => {
          setTimeout(() => {
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
              connection.destroy();
            }
          }, 1500);
        });

        return interaction.editReply({
          content: `🔊 ボイスチャンネル「**${memberVoice.channel.name}**」でテスト音（\`${soundFile}\`）を再生しました！聞こえましたか？`
        });
      } catch (err) {
        console.error('[Test Error]', err);
        return interaction.editReply({
          content: `❌ 音声の再生テストに失敗しました: ${err.message}`
        });
      }
    }

    // 2. 開始コマンド (/timer start)
    if (sub === 'start') {
      const timeInput = interaction.options.getString('time');
      const title = interaction.options.getString('title') || 'マダミス議論フェーズ';
      const seconds = parseDuration(timeInput);

      if (!seconds || seconds <= 0) {
        return interaction.reply({
          content: '❌ 時間の指定形式が正しくありません。（例: `15` = 15分, `10m` = 10分, `90s` = 90秒）',
          ephemeral: true
        });
      }

      // 既存タイマーの確認
      if (activeTimers.has(guildId)) {
        return interaction.reply({
          content: '⚠️ すでに実行中のタイマーがあります。終了させるかボタンから操作してください。',
          ephemeral: true
        });
      }

      await interaction.deferReply();

      // コマンド実行者がVCにいるか確認
      let connection = null;
      let vcWarning = '';
      const memberVoice = interaction.member.voice;

      if (memberVoice && memberVoice.channel) {
        try {
          console.log(`[Timer] Joining voice channel: ${memberVoice.channel.name}`);
          connection = joinVoiceChannel({
            channelId: memberVoice.channel.id,
            guildId: interaction.guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
          });

          // VC接続待機
          await entersState(connection, VoiceConnectionStatus.Ready, 7000);
          console.log('[Timer] Voice connection established.');
        } catch (err) {
          console.warn('[Timer] Could not join voice channel:', err.message);
          connection = null;
          //vcWarning = '\n⚠️ ボイスチャンネルへの接続に失敗しました。チャイム音なしでタイマーを開始します。';
        }
      } else {
        vcWarning = '\n💡 *コマンド実行者がボイスチャンネルに未接続のため、チャイム音なし（テキスト通知のみ）で動作します。*';
      }

      const session = new TimerSession({
        guildId,
        textChannel: interaction.channel,
        voiceConnection: connection,
        totalSeconds: seconds,
        title
      });

      activeTimers.set(guildId, session);
      await session.start(interaction);

      if (vcWarning) {
        interaction.followUp({ content: vcWarning, ephemeral: true }).catch(() => {});
      }
    }

    // 3. 停止コマンド (/timer stop)
    if (sub === 'stop') {
      const session = activeTimers.get(guildId);
      if (!session) {
        return interaction.reply({
          content: '❌ 現在実行中のタイマーはありません。',
          ephemeral: true
        });
      }
      await session.finish(true);
      return interaction.reply({
        content: '⏹️ タイマーを停止しました。',
        ephemeral: true
      });
    }
  }

  // ボタン操作処理
  if (interaction.isButton()) {
    const guildId = interaction.guildId;
    const session = activeTimers.get(guildId);

    if (!session) {
      return interaction.reply({
        content: 'このタイマーは既に終了しています。',
        ephemeral: true
      });
    }

    switch (interaction.customId) {
      case 'timer_toggle_pause': {
        const isPaused = await session.togglePause();
        await interaction.reply({
          content: isPaused ? '⏸️ タイマーを一時停止しました。' : '▶️ タイマーを再開しました。',
          ephemeral: true
        });
        break;
      }
      case 'timer_add_1m': {
        await session.addSeconds(60);
        await interaction.reply({
          content: '➕ 時間を 1分 追加しました。',
          ephemeral: true
        });
        break;
      }
      case 'timer_add_5m': {
        await session.addSeconds(300);
        await interaction.reply({
          content: '➕ 時間を 5分 追加しました。',
          ephemeral: true
        });
        break;
      }
      case 'timer_stop': {
        await session.finish(true);
        await interaction.reply({
          content: '⏹️ タイマーを終了しました。',
          ephemeral: true
        });
        break;
      }
    }
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token || token === 'your_bot_token_here') {
  console.error('ERROR: .env に DISCORD_TOKEN が設定されていません。');
  console.error('.env ファイルを作成し、Botのトークンを記入してください。');
  process.exit(1);
}

client.login(token);
