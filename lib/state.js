// 複数コマンド間で共有するセッション・データ管理

// サーバーごとのタイマーセッション管理: Map<guildId, TimerSession>
const activeTimers = new Map();

// サーバーごとのPLリスト管理: Map<guildId, string[]>
const plLists = new Map();

// 直近の /char 配役確定結果: Map<guildId, { userId: string, charName: string }[]>
const lastCharResults = new Map();

// 変更前の元ニックネーム保存: Map<guildId, Map<userId, { originalNick: string | null, originalDisplayName: string }>>
const savedNicknames = new Map();

function getPlList(guildId) {
  if (!plLists.has(guildId)) plLists.set(guildId, []);
  return plLists.get(guildId);
}

function getSavedNickMap(guildId) {
  if (!savedNicknames.has(guildId)) savedNicknames.set(guildId, new Map());
  return savedNicknames.get(guildId);
}

module.exports = {
  activeTimers,
  plLists,
  getPlList,
  lastCharResults,
  savedNicknames,
  getSavedNickMap,
};
