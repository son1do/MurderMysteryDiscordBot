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
  ActivityType,
  MessageFlags,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// commands/ フォルダから全コマンドを自動読み込み
const commandMap = new Map();
const buttonHandlers = [];
const selectMenuHandlers = [];
const commandsJson = [];

const commandsDir = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsDir).filter(file => file.endsWith('.js')).sort();

for (const file of commandFiles) {
  const cmd = require(path.join(commandsDir, file));
  if (!cmd?.data || typeof cmd.execute !== 'function') {
    console.warn(`[Loader] スキップ: ${file}（data または execute が未定義）`);
    continue;
  }

  commandMap.set(cmd.data.name, cmd);
  commandsJson.push(cmd.data);

  if (Array.isArray(cmd.buttonPrefixes) && typeof cmd.handleButton === 'function') {
    for (const prefix of cmd.buttonPrefixes) {
      buttonHandlers.push({ prefix, handler: cmd.handleButton, source: file });
    }
  }

  if (Array.isArray(cmd.selectMenuPrefixes) && typeof cmd.handleSelectMenu === 'function') {
    for (const prefix of cmd.selectMenuPrefixes) {
      selectMenuHandlers.push({ prefix, handler: cmd.handleSelectMenu, source: file });
    }
  }
}

console.log(`[Loader] ${commandMap.size} 個のコマンドを読み込みました: ${[...commandMap.keys()].map(n => `/${n}`).join(', ')}`);

// clientReady イベント
client.once('clientReady', async () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'MurderMystery', type: ActivityType.Playing }],
    status: 'online',
  });

  const guildId = process.env.GUILD_ID;
  if (guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      await guild.commands.set(commandsJson);
      console.log(`Commands registered to guild: ${guild.name} (${guildId})`);
    } else {
      console.warn(`Guild with ID ${guildId} not found, registering globally.`);
      await client.application.commands.set(commandsJson);
    }
  } else {
    await client.application.commands.set(commandsJson);
    console.log('Commands registered globally.');
  }
});

// インタラクション処理（スラッシュコマンド＆ボタンを各モジュールへ振り分け）
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commandMap.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      const matched = buttonHandlers.find(({ prefix }) => interaction.customId.startsWith(prefix));
      if (!matched) return;
      await matched.handler(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const matched = selectMenuHandlers.find(({ prefix }) => interaction.customId.startsWith(prefix));
      if (!matched) return;
      await matched.handler(interaction);
    }
  } catch (err) {
    console.error('[Interaction Error]', err);
    const errPayload = {
      content: '❌ コマンド処理中に予期しないエラーが発生しました。',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(errPayload).catch(() => {});
    } else {
      await interaction.reply(errPayload).catch(() => {});
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
