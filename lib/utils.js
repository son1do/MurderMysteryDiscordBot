// 共通ユーティリティ関数・定数

const VOTE_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * 配列をFisher-Yatesアルゴリズムでシャッフル（非破壊）
 */
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

module.exports = {
  VOTE_NUMBERS,
  shuffleArray,
  parseDuration,
  formatTime,
  createProgressBar,
};
