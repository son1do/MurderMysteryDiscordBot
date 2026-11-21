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
  // システムPATHのffmpegを使用
}

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const {
  joinVoiceChannel,
  getVoiceConnection,
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

// サーバーごとのPLリスト管理: Map<guildId, string[]>
const plLists = new Map();

function getPlList(guildId) {
  if (!plLists.has(guildId)) plLists.set(guildId, []);
  return plLists.get(guildId);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// サーバーごとの投票セッション管理: Map<guildId, VoteSession>
const voteSessions = new Map();

const VOTE_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * 匿名投票セッションクラス
 */
class VoteSession {
  constructor({ guildId, title, options, startedBy }) {
    this.guildId = guildId;
    this.title = title;
    this.options = options;      // string[]
    this.startedBy = startedBy;  // userId（GM）
    this.votes = new Map();      // Map<userId, number>（optionIndex）
    this.message = null;
    this.isOpen = true;
  }

  /** 投票（または変更）。戻り値: true=変更、false=新規 */
  castVote(userId, optionIndex) {
    const isChange = this.votes.has(userId);
    this.votes.set(userId, optionIndex);
    return isChange;
  }

  /** 選択肢ごとの集計を返す */
  getTally() {
    const tally = this.options.map((opt, i) => ({ option: opt, index: i, count: 0 }));
    for (const [, idx] of this.votes) {
      if (tally[idx]) tally[idx].count++;
    }
    return tally;
  }

  /** Embed生成（revealed=false: 投票中 / true: 結果公開） */
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

  /** ボタンRow配列を生成（選択肢ボタン最大4行 + GM操作ボタン1行） */
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
        if (VOTE_NUMBERS[idx]) {
          btn.setEmoji(VOTE_NUMBERS[idx]);
        }
        row.addComponents(btn);
      });
      rows.push(row);
    }

    // GM用コントロール行
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

  /** GM専用の事前確認Embed（集計＋誰が誰に投票したか） */
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

/**
 * ボイスチャンネルに接続する共通関数（自動クリーンアップ＆タイムアウト20秒）
 */
async function connectToVoice(voiceChannel, guild) {
  const existingConn = getVoiceConnection(guild.id);
  if (existingConn) {
    existingConn.destroy();
    await new Promise(r => setTimeout(r, 400));
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on('error', error => {
    console.error('[VoiceConnection Error]', error.message);
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  console.log(`[Voice] ボイスチャンネル「${voiceChannel.name}」に接続しました。`);
  return connection;
}

/**
 * 時間文字列 (例: "15m", "15", "1h30m", "90s") を秒数に変換
 */
function parseDuration(input) {
  if (!input) return null;
  const str = input.toString().trim().toLowerCase();

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

    if (this.voiceConnection) {
      this.voiceConnection.subscribe(this.player);
    }

    // 重複通知防止フラグ
    this.notified5m = totalSeconds <= 300;
    this.notified1m = totalSeconds <= 60;
  }

  playChime(soundFileName) {
    if (!this.voiceConnection) return;
    const soundPath = path.join(__dirname, 'sounds', soundFileName);
    if (!fs.existsSync(soundPath)) {
      console.warn(`[playChime] 音声ファイルが見つかりません: ${soundPath}`);
      return;
    }

    try {
      const resource = createAudioResource(soundPath, { inlineVolume: true });
      if (resource.volume) {
        resource.volume.setVolume(1.0);
      }
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
      components: [row]
    });

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

    // 5秒おきにメッセージを編集
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

    // タイマー終了後もボイスチャンネルに常駐させます（退出させたい場合は /timer disconnect）
  }
}

// スラッシュコマンド定義
const commands = [
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('マダミス用タイマーを操作します')
    .addSubcommand(sub =>
      sub
        .setName('connect')
        .setDescription('あなたが現在いるボイスチャンネルにBotを接続させます')
    )
    .addSubcommand(sub =>
      sub
        .setName('disconnect')
        .setDescription('ボイスチャンネルからBotを切断（退出）させます')
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
    ),
  new SlashCommandBuilder()
    .setName('dice')
    .setDescription('ダイス（サイコロ）を振ります')
    .addStringOption(opt =>
      opt
        .setName('roll')
        .setDescription('ダイスの形式（例: 1d100, 2d6, 1d6, 100）。省略時は 1d100')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt
        .setName('comment')
        .setDescription('ダイスを振る理由・項目名（例: 調査、発言順決め）')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('pl')
    .setDescription('PLリストを管理し、発言順シャッフルやランダム選択を行います')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('PLをリストに追加します')
        .addStringOption(opt =>
          opt.setName('name').setDescription('PL名（プレイヤー名）').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('PLをリストから削除します')
        .addStringOption(opt =>
          opt.setName('name').setDescription('削除するPL名').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('現在のPLリストを表示します')
    )
    .addSubcommand(sub =>
      sub.setName('clear').setDescription('PLリストをリセットします')
    )
    .addSubcommand(sub =>
      sub.setName('from-vc').setDescription('あなたがいるVCの全メンバー（Bot除く）をPLリストに一括登録します')
    )
    .addSubcommand(sub =>
      sub.setName('shuffle').setDescription('PLをシャッフルして発言順を表示します')
    )
    .addSubcommand(sub =>
      sub.setName('pick').setDescription('PLの中からランダムに1人選びます（ルーレット演出）')
    ),
  new SlashCommandBuilder()
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
  new SlashCommandBuilder()
    .setName('vc')
    .setDescription('ボイスチャンネルのメンバー操作を行います')
    .addSubcommand(sub =>
      sub
        .setName('gather')
        .setDescription('密談VCなどに散らばったメンバーを1つのVCに全員集合させます')
        .addChannelOption(opt =>
          opt
            .setName('target')
            .setDescription('集合先のVC（省略時はあなたが現在いるVC）')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('same_category')
            .setDescription('同じカテゴリー内のVCのみを対象にするか（デフォルト: True / 安全モード）')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('include_bots')
            .setDescription('Botも一緒に移動させるか（デフォルト: False）')
            .setRequired(false)
        )
    ),
];

// clientReady イベント
client.once('clientReady', async () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);

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
    // 🎲 ダイスコマンド (/dice)
    if (interaction.commandName === 'dice') {
      const rollInput = (interaction.options.getString('roll') || '1d100').trim().toLowerCase();
      const comment = interaction.options.getString('comment');

      let count = 1;
      let sides = 100;

      // "2d6", "1d100", "d6" 形式
      const diceMatch = rollInput.match(/^(\d*)d(\d+)$/);
      // "100", "6" などの数値形式
      const numberMatch = rollInput.match(/^(\d+)$/);

      if (diceMatch) {
        count = diceMatch[1] ? parseInt(diceMatch[1], 10) : 1;
        sides = parseInt(diceMatch[2], 10);
      } else if (numberMatch) {
        count = 1;
        sides = parseInt(numberMatch[1], 10);
      } else {
        return interaction.reply({
          content: '❌ ダイスの形式が正しくありません。（例: `1d100`, `2d6`, `1d6`, `100`）',
          flags: MessageFlags.Ephemeral
        });
      }

      if (count < 1 || count > 50 || sides < 1 || sides > 10000) {
        return interaction.reply({
          content: '❌ ダイスの個数は1〜50個、面数は1〜10000面の間で指定してください。',
          flags: MessageFlags.Ephemeral
        });
      }

      const results = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const val = Math.floor(Math.random() * sides) + 1;
        results.push(val);
        total += val;
      }

      const formulaStr = `${count}d${sides}${comment ? ` （${comment}）` : ''}`;
      const embed = new EmbedBuilder()
        .setTitle('🎲 ダイスロール')
        .setColor(0x3498DB)
        .setTimestamp();

      if (count === 1) {
        embed.setDescription(`${interaction.user} がダイスを振りました！\n\n**【 ${formulaStr} 】**\n## 🎯 出目: \` ${total} \` / ${sides}`);
      } else {
        const rollsDisplay = results.length <= 20 
          ? `[ ${results.join(', ')} ]` 
          : `[ ${results.slice(0, 20).join(', ')}, ... ]`;
        embed.setDescription(`${interaction.user} がダイスを振りました！\n\n**【 ${formulaStr} 】**\n出目: \`${rollsDisplay}\`\n## 🎯 合計: \` ${total} \``);
      }

      return interaction.reply({ embeds: [embed] });
    }

    // 🎭 PLコマンド (/pl)
    if (interaction.commandName === 'pl') {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const pls = getPlList(guildId);

      // /pl add
      if (sub === 'add') {
        const name = interaction.options.getString('name').trim();
        if (pls.includes(name)) {
          return interaction.reply({ content: `⚠️ **${name}** はすでにリストに登録されています。`, flags: MessageFlags.Ephemeral });
        }
        if (pls.length >= 30) {
          return interaction.reply({ content: '❌ PLリストは最大30名までです。', flags: MessageFlags.Ephemeral });
        }
        pls.push(name);
        return interaction.reply({ content: `✅ **${name}** をPLリストに追加しました。（現在: ${pls.length}名）` });
      }

      // /pl remove
      if (sub === 'remove') {
        const name = interaction.options.getString('name').trim();
        const idx = pls.indexOf(name);
        if (idx === -1) {
          return interaction.reply({ content: `❌ **${name}** はPLリストに存在しません。`, flags: MessageFlags.Ephemeral });
        }
        pls.splice(idx, 1);
        return interaction.reply({ content: `🗑️ **${name}** をPLリストから削除しました。（残り: ${pls.length}名）` });
      }

      // /pl list
      if (sub === 'list') {
        if (pls.length === 0) {
          return interaction.reply({ content: '📋 PLリストは空です。`/pl add` でPLを追加してください。', flags: MessageFlags.Ephemeral });
        }
        const embed = new EmbedBuilder()
          .setTitle('👥 現在のPLリスト')
          .setDescription(pls.map((name, i) => `**${i + 1}.** ${name}`).join('\n'))
          .setColor(0x3498DB)
          .setFooter({ text: `合計 ${pls.length} 名` })
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      // /pl clear
      if (sub === 'clear') {
        const prevCount = pls.length;
        pls.length = 0;
        return interaction.reply({ content: `🗑️ PLリストをリセットしました。（${prevCount}名 → 0名）` });
      }

      // /pl from-vc
      if (sub === 'from-vc') {
        const memberVoice = interaction.member.voice;
        if (!memberVoice || !memberVoice.channel) {
          return interaction.reply({ content: '❌ あなたがボイスチャンネル（VC）に接続していません。', flags: MessageFlags.Ephemeral });
        }
        const vcNames = memberVoice.channel.members
          .filter(m => !m.user.bot)
          .map(m => m.displayName);
        if (vcNames.length === 0) {
          return interaction.reply({ content: '❌ VCにBot以外のメンバーがいません。', flags: MessageFlags.Ephemeral });
        }
        pls.length = 0;
        pls.push(...vcNames);
        const embed = new EmbedBuilder()
          .setTitle('👥 VCからPLリストを登録しました')
          .setDescription(pls.map((name, i) => `**${i + 1}.** ${name}`).join('\n'))
          .setColor(0x2ECC71)
          .setFooter({ text: `合計 ${pls.length} 名` })
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      // /pl shuffle
      if (sub === 'shuffle') {
        if (pls.length < 2) {
          return interaction.reply({ content: '❌ シャッフルするにはPLが2名以上必要です。`/pl add` でPLを追加してください。', flags: MessageFlags.Ephemeral });
        }
        const shuffled = shuffleArray(pls);
        const medals = ['🥇', '🥈', '🥉'];
        const orderText = shuffled.map((name, i) => {
          const prefix = medals[i] ?? `**${i + 1}.**`;
          return `${prefix} ${name}`;
        }).join('\n');
        const embed = new EmbedBuilder()
          .setTitle('🔀 発言順シャッフル結果')
          .setDescription(orderText)
          .setColor(0x9B59B6)
          .setFooter({ text: `${pls.length}名をシャッフルしました` })
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      // /pl pick — ルーレット演出
      if (sub === 'pick') {
        if (pls.length === 0) {
          return interaction.reply({ content: '❌ PLリストが空です。`/pl add` でPLを追加してください。', flags: MessageFlags.Ephemeral });
        }

        // 先に当選者を決定（アニメーション中に変わらないように）
        const winner = pls[Math.floor(Math.random() * pls.length)];

        await interaction.deferReply();

        // ルーレットアニメーション（段々スローになる）
        const delays = [220, 280, 350, 480, 650];
        for (const delay of delays) {
          const rnd = pls[Math.floor(Math.random() * pls.length)];
          const spinEmbed = new EmbedBuilder()
            .setTitle('🎰 ルーレット中...')
            .setDescription(`# ${rnd}`)
            .setColor(0xF39C12);
          await interaction.editReply({ embeds: [spinEmbed] });
          await new Promise(r => setTimeout(r, delay));
        }

        // 結果発表
        const finalEmbed = new EmbedBuilder()
          .setTitle('🎯 選ばれたPL')
          .setDescription(`# 🎉 ${winner}`)
          .setColor(0xE74C3C)
          .setFooter({ text: `${pls.length}名の中からランダムに選出` })
          .setTimestamp();
        return interaction.editReply({ embeds: [finalEmbed] });
      }
    }

    // 🗳️ 匿名投票コマンド (/vote)
    if (interaction.commandName === 'vote') {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      // /vote start
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

      // /vote result / status / cancel
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
    }

    // 📢 ボイスチャンネル操作コマンド (/vc)
    if (interaction.commandName === 'vc') {
      const sub = interaction.options.getSubcommand();

      // /vc gather — 密談VCのメンバーを一斉集合
      if (sub === 'gather') {
        // 実行者の権限チェック
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers)) {
          return interaction.reply({
            content: '❌ このコマンドを実行するには「メンバーを移動（Move Members）」権限が必要です。',
            flags: MessageFlags.Ephemeral,
          });
        }

        // Botの権限チェック
        const botMember = interaction.guild.members.me;
        if (!botMember?.permissions.has(PermissionFlagsBits.MoveMembers)) {
          return interaction.reply({
            content: '❌ Botに「メンバーを移動（Move Members）」権限がありません。サーバー設定またはロール設定でBotに権限を付与してください。',
            flags: MessageFlags.Ephemeral,
          });
        }

        // 集合先VCの決定
        const targetOption = interaction.options.getChannel('target');
        const targetChannel = targetOption || interaction.member.voice?.channel;
        if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
          return interaction.reply({
            content: '❌ 集合先のVCが見つかりません。集合先VCに入ってから実行するか、`target` オプションでVCを指定してください。',
            flags: MessageFlags.Ephemeral,
          });
        }

        const sameCategory = interaction.options.getBoolean('same_category') ?? true;
        const includeBots = interaction.options.getBoolean('include_bots') ?? false;
        const afkChannelId = interaction.guild.afkChannelId;

        // 対象となる他のVCを抽出
        const sourceChannels = interaction.guild.channels.cache.filter(ch => {
          if (ch.type !== ChannelType.GuildVoice) return false;
          if (ch.id === targetChannel.id) return false;
          if (afkChannelId && ch.id === afkChannelId) return false;
          if (sameCategory && targetChannel.parentId && ch.parentId !== targetChannel.parentId) return false;
          return true;
        });

        // 移動対象メンバーを収集
        const moveTargets = [];
        for (const [, ch] of sourceChannels) {
          for (const [, member] of ch.members) {
            if (!includeBots && member.user.bot) continue;
            moveTargets.push({ member, fromChannelName: ch.name });
          }
        }

        if (moveTargets.length === 0) {
          const scopeLabel = sameCategory && targetChannel.parentId
            ? `同じカテゴリー（${targetChannel.parent?.name || '不明'}）内の他VC`
            : 'サーバー内の他VC';
          return interaction.reply({
            content: `ℹ️ ${scopeLabel}に移動対象のメンバーはいませんでした。`,
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferReply();

        // 一斉移動を実行
        const results = await Promise.allSettled(
          moveTargets.map(async ({ member, fromChannelName }) => {
            await member.voice.setChannel(targetChannel, `VC全員集合 (/vc gather by ${interaction.user.tag})`);
            return { name: member.displayName, fromChannelName };
          })
        );

        const movedByChannel = new Map();
        const failed = [];

        results.forEach((res, i) => {
          if (res.status === 'fulfilled') {
            const { name, fromChannelName } = res.value;
            if (!movedByChannel.has(fromChannelName)) movedByChannel.set(fromChannelName, []);
            movedByChannel.get(fromChannelName).push(name);
          } else {
            failed.push(moveTargets[i].member.displayName);
          }
        });

        const movedCount = moveTargets.length - failed.length;
        const breakdownLines = [...movedByChannel.entries()].map(
          ([chName, names]) => `・🔊 **${chName}** → ${names.join(', ')}`
        );

        const embed = new EmbedBuilder()
          .setTitle(`📢 メンバーを「${targetChannel.name}」に集合させました！`)
          .setColor(0x2ECC71)
          .setDescription(
            breakdownLines.length > 0
              ? breakdownLines.join('\n')
              : '移動できたメンバーはいませんでした。'
          )
          .setFooter({
            text: `移動完了: ${movedCount}名${failed.length > 0 ? ` / 失敗: ${failed.length}名` : ''}${sameCategory && targetChannel.parentId ? ' ｜ 同カテゴリー内のみ対象' : ' ｜ サーバー全体対象'}`
          })
          .setTimestamp();

        if (failed.length > 0) {
          embed.addFields({ name: '⚠️ 移動できなかったメンバー', value: failed.join(', ') });
        }

        console.log(`[VC Gather] ${movedCount}名を「${targetChannel.name}」に移動しました。`);
        return interaction.editReply({ embeds: [embed] });
      }
    }

    if (interaction.commandName !== 'timer') return;

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // 1. 接続コマンド (/timer connect)
    if (sub === 'connect') {
      const memberVoice = interaction.member.voice;
      if (!memberVoice || !memberVoice.channel) {
        return interaction.reply({
          content: '❌ あなたがボイスチャンネル（VC）に接続していません。VCに入ってから実行してください。',
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply();

      try {
        await connectToVoice(memberVoice.channel, interaction.guild);
        return interaction.editReply({
          content: `✅ ボイスチャンネル「**${memberVoice.channel.name}**」に接続しました！このままタイマーを開始できます。`
        });
      } catch (err) {
        console.error('[Connect Error]', err.message);
        return interaction.editReply({
          content: `❌ ${err.message}`
        });
      }
    }

    // 2. 切断コマンド (/timer disconnect)
    if (sub === 'disconnect') {
      const connection = getVoiceConnection(guildId);
      if (!connection) {
        return interaction.reply({
          content: 'ボイスチャンネルに接続していません。',
          flags: MessageFlags.Ephemeral
        });
      }

      connection.destroy();
      console.log('[Voice] ボイスチャンネルから退出しました。');
      return interaction.reply({
        content: '👋 ボイスチャンネルから退出しました。'
      });
    }

    // 3. テストコマンド (/timer test)
    if (sub === 'test') {
      const memberVoice = interaction.member.voice;
      if (!memberVoice || !memberVoice.channel) {
        return interaction.reply({
          content: '❌ あなたがボイスチャンネル（VC）に接続していません。VCに入ってから実行してください。',
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const soundFile = interaction.options.getString('type') || 'notice.wav';
      const soundPath = path.join(__dirname, 'sounds', soundFile);

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
          content: `🔊 ボイスチャンネル「**${memberVoice.channel.name}**」でテスト音（\`${soundFile}\`）を再生しました！`
        });
      } catch (err) {
        console.error('[Test Error]', err.message);
        return interaction.editReply({
          content: `❌ ${err.message}`
        });
      }
    }

    // 4. 開始コマンド (/timer start)
    if (sub === 'start') {
      const timeInput = interaction.options.getString('time');
      const title = interaction.options.getString('title') || 'マダミス議論フェーズ';
      const seconds = parseDuration(timeInput);

      if (!seconds || seconds <= 0) {
        return interaction.reply({
          content: '❌ 時間の指定形式が正しくありません。（例: `15` = 15分, `10m` = 10分, `90s` = 90秒）',
          flags: MessageFlags.Ephemeral
        });
      }

      if (activeTimers.has(guildId)) {
        return interaction.reply({
          content: '⚠️ すでに実行中のタイマーがあります。終了させるかボタンから操作してください。',
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply();

      // 既存のVC接続があれば流用、なければ新規接続
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
        title
      });

      activeTimers.set(guildId, session);
      await session.start(interaction);

      if (vcWarning) {
        interaction.followUp({ content: vcWarning, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    // 5. 停止コマンド (/timer stop)
    if (sub === 'stop') {
      const session = activeTimers.get(guildId);
      if (!session) {
        return interaction.reply({
          content: '❌ 現在実行中のタイマーはありません。',
          flags: MessageFlags.Ephemeral
        });
      }
      await session.finish(true);
      return interaction.reply({
        content: '⏹️ タイマーを停止しました。',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  // ボタン操作処理
  if (interaction.isButton()) {
    const guildId = interaction.guildId;

    // 🗳️ 投票ボタン処理
    if (interaction.customId.startsWith('vote_')) {
      const voteSession = voteSessions.get(guildId);
      if (!voteSession || !voteSession.isOpen) {
        return interaction.reply({
          content: '❌ この投票はすでに終了しています。',
          flags: MessageFlags.Ephemeral,
        });
      }

      // 選択肢ボタン (vote_opt_<index>)
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

        // 投票総数のみ更新（内訳は非公開のまま）
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

      // GM専用：公開前の内訳プレビュー（Ephemeral）
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

      // GM操作ボタン（結果を公開 / 中止）
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
        return;
      }
    }

    // ⏱️ タイマーボタン処理
    const session = activeTimers.get(guildId);

    if (!session) {
      return interaction.reply({
        content: 'このタイマーは既に終了しています。',
        flags: MessageFlags.Ephemeral
      });
    }

    switch (interaction.customId) {
      case 'timer_toggle_pause': {
        const isPaused = await session.togglePause();
        await interaction.reply({
          content: isPaused ? '⏸️ タイマーを一時停止しました。' : '▶️ タイマーを再開しました。',
          flags: MessageFlags.Ephemeral
        });
        break;
      }
      case 'timer_add_1m': {
        await session.addSeconds(60);
        await interaction.reply({
          content: '➕ 時間を 1分 追加しました。',
          flags: MessageFlags.Ephemeral
        });
        break;
      }
      case 'timer_add_5m': {
        await session.addSeconds(300);
        await interaction.reply({
          content: '➕ 時間を 5分 追加しました。',
          flags: MessageFlags.Ephemeral
        });
        break;
      }
      case 'timer_stop': {
        await session.finish(true);
        await interaction.reply({
          content: '⏹️ タイマーを終了しました。',
          flags: MessageFlags.Ephemeral
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
