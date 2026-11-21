const path = require('path');
const fs = require('fs');
const { EmbedBuilder, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { activeTimers } = require('./state');

const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');
const EMPTY_VC_TIMEOUT_MS = 5 * 60 * 1000; // 無人状態5分で自動切断

// サーバーごとの無人VC自動切断タイマー: Map<guildId, NodeJS.Timeout>
const emptyVcTimers = new Map();

/**
 * 無人VC自動切断タイマーをキャンセル
 */
function cancelEmptyVcTimer(guildId) {
  const existing = emptyVcTimers.get(guildId);
  if (existing) {
    clearTimeout(existing);
    emptyVcTimers.delete(guildId);
  }
}

/**
 * Botと同じVCに人間メンバーがいるか確認し、無人なら5分後に自動切断を予約
 */
function checkAndScheduleAutoDisconnect(guild) {
  if (!guild) return;
  const guildId = guild.id;
  const connection = getVoiceConnection(guildId);
  if (!connection) {
    cancelEmptyVcTimer(guildId);
    return;
  }

  const botChannelId = connection.joinConfig?.channelId;
  const channel = botChannelId ? guild.channels.cache.get(botChannelId) : null;
  if (!channel) {
    cancelEmptyVcTimer(guildId);
    return;
  }

  const humanCount = channel.members.filter(m => !m.user.bot).size;

  if (humanCount > 0) {
    if (emptyVcTimers.has(guildId)) {
      cancelEmptyVcTimer(guildId);
      console.log(`[Voice] 「${channel.name}」にメンバーが戻ったため、自動退出タイマーを解除しました。`);
    }
    return;
  }

  // 無人状態：すでにタイマー動作中ならそのまま維持
  if (emptyVcTimers.has(guildId)) return;

  console.log(`[Voice] 「${channel.name}」にメンバーがいなくなりました。5分後に自動退出します。`);
  const timer = setTimeout(() => {
    emptyVcTimers.delete(guildId);
    const currentConn = getVoiceConnection(guildId);
    if (!currentConn) return;

    const currentChId = currentConn.joinConfig?.channelId;
    const currentCh = currentChId ? guild.channels.cache.get(currentChId) : null;
    const currentHumans = currentCh ? currentCh.members.filter(m => !m.user.bot).size : 0;

    if (currentHumans === 0) {
      currentConn.destroy();
      const activeTimer = activeTimers.get(guildId);
      if (activeTimer) {
        activeTimer.voiceConnection = null;
        activeTimer.updateMessage().catch(() => {});
      }
      console.log(`[Voice] 無人状態が5分間続いたため、ボイスチャンネル「${currentCh?.name || '不明'}」から自動退出しました。`);
    }
  }, EMPTY_VC_TIMEOUT_MS);

  emptyVcTimers.set(guildId, timer);
}

/**
 * ボイスチャンネルに接続する共通関数（自動クリーンアップ＆タイムアウト20秒）
 */
async function connectToVoice(voiceChannel, guild) {
  cancelEmptyVcTimer(guild.id);
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
  checkAndScheduleAutoDisconnect(guild);
  return connection;
}

/**
 * VC接続中であればチャイムを鳴らす共通ヘルパー
 */
function playChimeIfConnected(guildId, soundFileName = 'notice.wav') {
  const timerSession = activeTimers.get(guildId);
  if (timerSession) {
    timerSession.playChime(soundFileName);
    return;
  }
  const connection = getVoiceConnection(guildId);
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) return;

  const soundPath = path.join(SOUNDS_DIR, soundFileName);
  if (!fs.existsSync(soundPath)) return;

  try {
    const player = createAudioPlayer();
    player.on('error', err => console.error('[Chime Error]', err.message));
    const resource = createAudioResource(soundPath, { inlineVolume: true });
    if (resource.volume) resource.volume.setVolume(1.0);
    connection.subscribe(player);
    player.play(resource);
  } catch (err) {
    console.error('[playChimeIfConnected Error]', err.message);
  }
}

/**
 * 他のVCにいるメンバーを指定のVCへ一斉集合させる共通関数
 */
async function gatherMembersToVoice({ guild, targetChannel, requestedByTag, sameCategory = true, includeBots = false }) {
  const afkChannelId = guild.afkChannelId;

  const sourceChannels = guild.channels.cache.filter(ch => {
    if (ch.type !== ChannelType.GuildVoice) return false;
    if (ch.id === targetChannel.id) return false;
    if (afkChannelId && ch.id === afkChannelId) return false;
    if (sameCategory && targetChannel.parentId && ch.parentId !== targetChannel.parentId) return false;
    return true;
  });

  const moveTargets = [];
  for (const [, ch] of sourceChannels) {
    for (const [, member] of ch.members) {
      if (!includeBots && member.user.bot) continue;
      moveTargets.push({ member, fromChannelName: ch.name });
    }
  }

  const scopeLabel = sameCategory && targetChannel.parentId
    ? `同じカテゴリー（${targetChannel.parent?.name || '不明'}）内の他VC`
    : 'サーバー内の他VC';

  if (moveTargets.length === 0) {
    return { totalTargets: 0, movedCount: 0, movedByChannel: new Map(), failed: [], scopeLabel };
  }

  const results = await Promise.allSettled(
    moveTargets.map(async ({ member, fromChannelName }) => {
      await member.voice.setChannel(targetChannel, `VC全員集合 (by ${requestedByTag})`);
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
  return { totalTargets: moveTargets.length, movedCount, movedByChannel, failed, scopeLabel };
}

/**
 * 集合結果のEmbedを生成
 */
function buildGatherResultEmbed({ targetChannel, movedCount, movedByChannel, failed, sameCategory }) {
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
      text: `移動完了: ${movedCount}名${failed.length > 0 ? ` / 失敗: ${failed.length}名` : ''}${sameCategory && targetChannel.parentId ? ' ｜ 同カテゴリー内のみ対象' : ' ｜ サーバー全体対象'}`,
    })
    .setTimestamp();

  if (failed.length > 0) {
    embed.addFields({ name: '⚠️ 移動できなかったメンバー', value: failed.join(', ') });
  }
  return embed;
}

module.exports = {
  SOUNDS_DIR,
  connectToVoice,
  cancelEmptyVcTimer,
  checkAndScheduleAutoDisconnect,
  playChimeIfConnected,
  gatherMembersToVoice,
  buildGatherResultEmbed,
};
