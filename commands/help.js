const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const HELP_SECTIONS = {
  timer: {
    name: '⏱️ タイマー (`/timer`)',
    value: [
      '`/timer start time:<時間> [title]` — タイマー開始（例: `15`, `15m`, `90s`, `1h30m`）',
      '`/timer stop` — 実行中のタイマーを停止',
      '`/timer connect` / `disconnect` — BotのVC参加・退出',
      '`/timer test [type]` — チャイム音のテスト再生',
      '💡 残り5分・1分・終了時にVCチャイム＆通知。ボタンで一時停止・+1/+3/+5分延長、終了時に「全員集合」ボタンが表示されます。',
    ].join('\n'),
  },
  dice: {
    name: '🎲 ダイス (`/dice`)',
    value: [
      '`/dice [roll] [comment] [panel]` — サイコロを振る（省略時は `1d100`）',
      '💡 結果の下にみんなも押せるダイスボタンが表示されます。`panel:True` でみんな用のダイスボタンパネルだけを出すこともできます。',
    ].join('\n'),
  },
  pl: {
    name: '👥 PL管理・シャッフル (`/pl`)',
    value: [
      '`/pl from-vc` — VCメンバー（Bot除く）をPLリストに一括登録',
      '`/pl add name:<名前>` / `remove` / `list` / `clear` — PLリストの編集・確認',
      '`/pl shuffle` — 発言順をランダムにシャッフル（🥇🥈🥉付き）',
      '`/pl pick` — ルーレット演出で1人をランダム選出',
    ].join('\n'),
  },
  vote: {
    name: '🗳️ 匿名投票 (`/vote`)',
    value: [
      '`/vote start [title] [options]` — ボタン式の匿名投票を開始（`options` 省略時は `/pl` リストを使用）',
      '`/vote status` — 現在の集計・投票内訳をGMだけに表示',
      '`/vote result` — 投票を締め切り、棒グラフ＆最多得票👑付きで公開（作成者のみ）',
      '`/vote cancel` — 結果非公開のまま中止（作成者のみ）',
      '💡 メッセージ下のGMボタン（👁️内訳確認 / 📊結果公開 / 🗑️中止）からも操作できます。',
    ].join('\n'),
  },
  vc: {
    name: '📢 VC操作 (`/vc`)',
    value: [
      '`/vc split [size] [source] [include_self]` — VCメンバーをランダム組分けして密談VCへ一斉振り分け（デフォルト: 2人ペア）',
      '`/vc gather [target] [same_category]` — 密談VCなどに散らばったメンバーを一斉集合（デフォルト: 同カテゴリー内のみ）',
      '`/vc mute [target] [include_self]` — VCメンバーを一斉サーバーミュート（デフォルト: 実行者とBotを除く）',
      '`/vc unmute [target]` — VCメンバーのサーバーミュートを一斉解除',
      '💡 `Move Members` / `Mute Members` 権限が必要です。',
    ].join('\n'),
  },
  ready: {
    name: '✅ 読み込み完了チェック (`/ready`)',
    value: [
      '`/ready start [title] [target_count] [include_self]` — 読み込み完了ボタンを表示（VCメンバーから対象を自動取得）',
      '`/ready cancel` — 進行中のチェックを中止',
      '💡 誰が終わって誰が読み込み中かをリアルタイム表示。全員押すと自動通知＆VCチャイムが鳴ります！',
    ].join('\n'),
  },
  secret: {
    name: '✉️ 秘密メッセージ・密書 (`/secret`)',
    value: [
      '`/secret to:<相手> message:<本文> [title] [anonymous] [announce]` — 指定メンバーにBot経由でDM送信',
      '💡 送信成否は送信者だけに通知。`anonymous:True` で匿名密書、`announce:True` でチャンネルに到着演出を出せます。',
    ].join('\n'),
  },
  turn: {
    name: '🎤 リレータイマー (`/turn`)',
    value: [
      '`/turn start time:<時間> [title] [shuffle] [members]` — 1人ずつ順番に持ち時間を計測（例: `60s`, `1m`, `2`）',
      '`/turn stop` — 実行中のリレータイマーを中断',
      '💡 `members` 省略時は `/pl` リスト（未登録ならVCメンバー）を自動使用。「⏭️ 次の人へ」「➕ +30秒」ボタンでサクサク進行できます。',
    ].join('\n'),
  },
  char: {
    name: '🎭 キャラ配役・抽選 (`/char`)',
    value: [
      '`/char start characters:<キャラ1,キャラ2,...> [title] [secret]` — キャラ希望選択パネルを作成',
      '`/char resolve` / `cancel` — 段階的抽選＆配役確定／中止（作成者のみ）',
      '💡 希望が被ったキャラは抽選し、外れた人は残りの空きキャラから次ラウンドで選び直せます！',
    ].join('\n'),
  },
  nick: {
    name: '🏷️ キャラ名ニックネーム (`/nick`)',
    value: [
      '`/nick from-char [format]` — 直近の `/char` 配役結果で全員のニックネームを一括変更',
      '`/nick set user:<相手> character:<キャラ名> [format]` — 個別にキャラ名へ変更',
      '`/nick reset` — 変更した全員のニックネームを元の名前へ一括復元',
      '`/nick list` — 復元対象メンバーを確認',
      '💡 `Manage Nicknames` 権限が必要です（サーバー所有者はDiscord仕様上、手動変更になります）。',
    ].join('\n'),
  },
  scenario: {
    name: '📚 シナリオ概要カード (`/scenario`)',
    value: [
      '`/scenario search title:<作品名>` — BOOTHからマダミス作品を検索し、候補から選んで概要カードを投稿',
      '`/scenario url url:<URL> [preview]` — BOOTH・マダミス.jp・ウズ等のURLから概要カードを生成して投稿',
      '💡 検索候補はまず実行者だけに表示されるため、誤爆せずに正しい作品をチャットへ貼れます！',
    ].join('\n'),
  },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Botのコマンド一覧と使い方を表示します')
    .addStringOption(opt =>
      opt
        .setName('category')
        .setDescription('詳しく見たい機能カテゴリ（省略時は一覧表示）')
        .setRequired(false)
        .addChoices(
          { name: '⏱️ タイマー (/timer)', value: 'timer' },
          { name: '🎲 ダイス (/dice)', value: 'dice' },
          { name: '👥 PL管理・シャッフル (/pl)', value: 'pl' },
          { name: '🗳️ 匿名投票 (/vote)', value: 'vote' },
          { name: '📢 VC操作 (/vc)', value: 'vc' },
          { name: '✅ 読み込み完了チェック (/ready)', value: 'ready' },
          { name: '✉️ 秘密メッセージ (/secret)', value: 'secret' },
          { name: '🎤 リレータイマー (/turn)', value: 'turn' },
          { name: '🎭 キャラ配役・抽選 (/char)', value: 'char' },
          { name: '🏷️ キャラ名ニックネーム (/nick)', value: 'nick' },
          { name: '📚 シナリオ概要カード (/scenario)', value: 'scenario' }
        )
    )
    .addBooleanOption(opt =>
      opt
        .setName('public')
        .setDescription('チャンネル全員に表示するか（デフォルト: False / 自分だけに表示）')
        .setRequired(false)
    ),

  async execute(interaction) {
    const category = interaction.options.getString('category');
    const isPublic = interaction.options.getBoolean('public') ?? false;
    const replyOpts = isPublic ? {} : { flags: MessageFlags.Ephemeral };

    const embed = new EmbedBuilder()
      .setTitle('📖 マダミスユーティリティBot コマンドヘルプ')
      .setColor(0x5865F2)
      .setTimestamp();

    if (category && HELP_SECTIONS[category]) {
      embed
        .setDescription(`**${HELP_SECTIONS[category].name}** の詳しい使い方です。`)
        .addFields(HELP_SECTIONS[category]);
    } else {
      embed
        .setDescription('マダミス進行に使えるコマンド一覧です。`category` オプションで機能ごとに絞り込むこともできます。')
        .addFields(Object.values(HELP_SECTIONS))
        .setFooter({ text: '全員に共有したい場合は /help public:True を指定してください' });
    }

    return interaction.reply({ embeds: [embed], ...replyOpts });
  },
};
