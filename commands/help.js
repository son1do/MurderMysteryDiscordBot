const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const COMMAND_DETAILS = {
  scenario: {
    emoji: '📚',
    label: '/scenario — シナリオ概要カード',
    short: 'BOOTH検索やURLからあらすじカードを投稿',
    color: 0xE91E63,
    summary: '開始前にシナリオのあらすじ・サムネイル・リンクをチャットへ綺麗に貼れます。',
    usage: [
      '`/scenario search title:<作品名>`\n└ BOOTHから検索し、GMだけに候補を表示 → 選んで投稿',
      '`/scenario url url:<URL> [preview]`\n└ BOOTH・マダミス.jp・ウズ等のURLから概要カードを生成',
    ],
    example: '`/scenario search title:狂気山脈`',
  },
  char: {
    emoji: '🎭',
    label: '/char — キャラ配役・段階的抽選',
    short: '希望ボタン表示＆重複キャラの段階的ランダム抽選',
    color: 0x9B59B6,
    summary: '希望が1人のキャラはその場で確定、被ったキャラは抽選し、外れた人は次ラウンドで空きキャラから選び直せます。',
    usage: [
      '`/char start characters:<キャラ1,キャラ2,...> [title] [secret]`\n└ 希望選択パネルを作成（2〜20キャラ、`secret:True`で非公開）',
      '`/char resolve` — 抽選・確定を実行（パネルのGMボタンからも可）',
      '`/char cancel` — 配役決めを中止',
    ],
    example: '`/char start characters:探偵,執事,メイド,医師`',
  },
  nick: {
    emoji: '🏷️',
    label: '/nick — キャラ名ニックネーム変更＆復元',
    short: '全員のニックネームをキャラ名に一括変更＆終了後リセット',
    color: 0x2ECC71,
    summary: '`/char` の配役結果や個別指定で `探偵（田中）` のように一括変更し、終了後に元の名前へ復元できます。',
    usage: [
      '`/nick from-char [format]` — 直近の `/char` 結果で全員一括変更',
      '`/nick set user:<相手> character:<キャラ名> [format]` — 個別に変更',
      '`/nick reset` — 変更した全員のニックネームを元の名前に復元',
      '`/nick list` — 復元対象メンバーを確認',
    ],
    example: '`/nick from-char` → 終了後 `/nick reset`\n⚠️ `Manage Nicknames` 権限が必要（サーバー所有者は手動変更）',
  },
  pl: {
    emoji: '👥',
    label: '/pl — PLリスト・発言順シャッフル・ルーレット',
    short: 'VCから一括登録、発言順シャッフル、ルーレット選出',
    color: 0x3498DB,
    summary: '参加PLをリスト管理し、発言順決めやランダム選出に活用できます（`/vote` や `/turn` とも自動連携）。',
    usage: [
      '`/pl from-vc` — 今いるVCのメンバー（Bot除く）を一括登録',
      '`/pl add name:<名前>` / `remove` / `list` / `clear` — リスト編集',
      '`/pl shuffle` — 🥇🥈🥉付きで発言順をランダムシャッフル',
      '`/pl pick` — ルーレット演出で1人をランダム選出',
    ],
    example: '`/pl from-vc` → `/pl shuffle`',
  },
  ready: {
    emoji: '✅',
    label: '/ready — 読み込み完了・準備OKチェック',
    short: 'ハンドアウト読み込み完了をボタンでリアルタイム把握',
    color: 0x2ECC71,
    summary: '誰が終わって誰が読み込み中かをリアルタイム表示。全員押すと自動通知＆VCチャイムでお知らせします。',
    usage: [
      '`/ready start [title] [target_count] [include_self]`\n└ 完了ボタンを表示（省略時は同じVCのメンバーを自動対象）',
      '`/ready cancel` — 進行中のチェックを中止',
    ],
    example: '`/ready start title:ハンドアウト読み込み`',
  },
  timer: {
    emoji: '⏱️',
    label: '/timer — 議論・密談タイマー（VCチャイム連動）',
    short: '残り5分/1分/終了チャイム＋延長ボタン＋終了時集合ボタン',
    color: 0x2ECC71,
    summary: '残り5分・1分・終了時にVCチャイムとテキスト通知。ボタンで一時停止・`+1分/+3分/+5分`延長、終了時に「全員集合」ボタンが表示されます。',
    usage: [
      '`/timer start time:<時間> [title]` — メインタイマー開始（`15`, `15m`, `90s`, `1h30m`）',
      '`/timer sub time:<時間> [title]` — メインと同時並行で動く小さなサブタイマー開始（最大5個）',
      '`/timer stop` — 実行中のメインタイマーを停止',
      '`/timer connect` / `disconnect` — BotのVC参加・退出（終了後も常駐、無人5分で自動切断）',
      '`/timer test [type]` — チャイム音のテスト再生',
    ],
    example: '`/timer start time:15m title:全体議論①`',
  },
  turn: {
    emoji: '🎤',
    label: '/turn — 最終弁論・自己紹介リレータイマー',
    short: '1人ずつ持ち時間を計測＆「次の人へ」ボタンで進行',
    color: 0xE67E22,
    summary: '`/pl` リスト（またはVCメンバー）の順に1人ずつ持ち時間を計測。時間切れチャイム＋`⏭️ 次の人へ`・`➕ +30秒`ボタンで進行できます。',
    usage: [
      '`/turn start time:<時間> [title] [shuffle] [members]` — リレー開始',
      '`/turn stop` — リレータイマーを中断',
    ],
    example: '`/turn start time:60s title:最終弁論 shuffle:True`',
  },
  vc: {
    emoji: '📢',
    label: '/vc — ボイスチャンネル一括操作',
    short: '密談VCへのランダム振り分け・全員集合・一斉ミュート',
    color: 0x1ABC9C,
    summary: '密談フェーズの移動や、GM説明・朗読時のマイク制御をワンコマンドで行えます。',
    usage: [
      '`/vc split [size] [source] [include_self]` — ランダム組分けして密談VCへ移動',
      '`/vc gather [target] [same_category]` — 同カテゴリー内の他VCから一斉集合',
      '`/vc mute [target] [include_self]` — GMとBot以外を一斉サーバーミュート',
      '`/vc unmute [target]` — サーバーミュートを一斉解除',
    ],
    example: '`/vc split size:2` → 終了後 `/vc gather`\n⚠️ `Move Members` / `Mute Members` 権限が必要',
  },
  dice: {
    emoji: '🎲',
    label: '/dice — ダイスロール＆みんな用ボタン',
    short: '1d100・2d6等のダイス＆ワンクリック用ボタンパネル',
    color: 0x3498DB,
    summary: 'ダイスを振ると結果の下にみんなも押せるボタンが付きます。`panel:True` で定番4種のボタンパネルだけ置くこともできます。',
    usage: [
      '`/dice [roll] [comment]` — ダイスを振る（省略時は `1d100`）',
      '`/dice panel:True` — みんな用ダイスボタン（1d100 / 1d6 / 2d6 / 1d20）を表示',
    ],
    example: '`/dice roll:2d6 comment:調査` または `/dice panel:True`',
  },
  secret: {
    emoji: '✉️',
    label: '/secret — 秘密メッセージ（密書）DM送信',
    short: 'Bot経由で特定PLへこっそりDM送信（匿名・到着演出対応）',
    color: 0x9B59B6,
    summary: 'GMからの追加ハンドアウト配布や、PL同士の密書をDM送信。送信の成否は送信者だけに通知されます。',
    usage: [
      '`/secret to:<相手> message:<本文> [title] [anonymous] [announce]`',
      '└ `anonymous:True` で差出人を匿名化、`announce:True` でチャンネルに到着演出',
    ],
    example: '`/secret to:@田中 message:書斎の鍵を見つけた anonymous:True`',
  },
  vote: {
    emoji: '🗳️',
    label: '/vote — 匿名投票（GM事前確認＆棒グラフ公開）',
    short: 'ボタンで匿名投票 → GM内訳確認 → 棒グラフ付き公開',
    color: 0xE74C3C,
    summary: '選択肢を省略すると `/pl` リストを自動使用。PLはボタンで匿名投票（変更可）、GMは公開前に内訳をこっそり確認できます。',
    usage: [
      '`/vote start [title] [options]` — ボタン式の匿名投票を開始',
      '`/vote status` — 集計と投票内訳をGMだけに表示（👁️ボタンでも可）',
      '`/vote result` — 投票を締め切り、棒グラフ＆最多得票👑付きで公開',
      '`/vote cancel` — 結果非公開のまま中止',
    ],
    example: '`/vote start title:犯人は誰？ options:田中,佐藤,鈴木,高橋`',
  },
};

function buildOverviewEmbed() {
  return new EmbedBuilder()
    .setTitle('📖 マダミスユーティリティBot — コマンド一覧')
    .setColor(0x5865F2)
    .setDescription(
      'セッションの流れに沿ってコマンドを整理しています。\n' +
      '👇 **下のプルダウンからコマンドを選ぶと、詳しい使い方と入力例が見られます！**'
    )
    .addFields(
      {
        name: '🎬 準備・導入フェーズ',
        value: [
          '📚 **`/scenario`** — BOOTH検索やURLからシナリオ概要カードを投稿',
          '🎭 **`/char`** — キャラ希望選択＆重複キャラの段階的ランダム抽選',
          '🏷️ **`/nick`** — キャラ名へ一括ニックネーム変更＆終了後に元へ復元',
          '👥 **`/pl`** — PLリスト管理（VC一括登録・発言順シャッフル・ルーレット）',
          '✅ **`/ready`** — ハンドアウト読み込み完了チェック（全員完了で通知＆チャイム）',
        ].join('\n'),
      },
      {
        name: '⏱️ 議論・密談フェーズ',
        value: [
          '⏱️ **`/timer`** — 議論・密談タイマー（チャイム・延長ボタン・終了時集合ボタン）',
          '🎤 **`/turn`** — 最終弁論・自己紹介用の1人ずつリレータイマー',
          '📢 **`/vc`** — 密談VCへのランダム振り分け・全員集合・一斉ミュート',
          '🎲 **`/dice`** — ダイスロール＆みんな用のワンクリックボタンパネル',
          '✉️ **`/secret`** — 指定PLへの秘密メッセージ（密書）DM送信',
        ].join('\n'),
      },
      {
        name: '🗳️ 投票・決着フェーズ',
        value: [
          '🗳️ **`/vote`** — ボタン式匿名投票（GM専用内訳プレビュー＆棒グラフ公開）',
        ].join('\n'),
      }
    )
    .setFooter({ text: '全員に共有したい場合は /help public:True を指定してください' })
    .setTimestamp();
}

function buildDetailEmbed(key) {
  const info = COMMAND_DETAILS[key];
  return new EmbedBuilder()
    .setTitle(`${info.emoji} ${info.label}`)
    .setColor(info.color)
    .setDescription(info.summary)
    .addFields(
      { name: '📌 コマンド・オプション', value: info.usage.join('\n') },
      { name: '💡 使用例', value: info.example }
    )
    .setFooter({ text: '下のプルダウンから別のコマンドや「🏠 一覧に戻る」を選べます' })
    .setTimestamp();
}

function buildSelectRow(selectedKey = 'overview') {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_select_category')
    .setPlaceholder('📖 詳しく見たいコマンドを選ぶ...')
    .addOptions([
      {
        label: '一覧に戻る（全コマンド概要）',
        value: 'overview',
        emoji: '🏠',
        description: 'フェーズ別の全コマンド一覧を表示',
        default: selectedKey === 'overview',
      },
      ...Object.entries(COMMAND_DETAILS).map(([key, info]) => ({
        label: info.label.slice(0, 100),
        value: key,
        emoji: info.emoji,
        description: info.short.slice(0, 100),
        default: selectedKey === key,
      })),
    ]);

  return new ActionRowBuilder().addComponents(menu);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Botのコマンド一覧と使い方を表示します')
    .addStringOption(opt =>
      opt
        .setName('category')
        .setDescription('詳しく見たい機能カテゴリ（省略時はフェーズ別の一覧表示）')
        .setRequired(false)
        .addChoices(
          ...Object.entries(COMMAND_DETAILS).map(([key, info]) => ({
            name: `${info.emoji} ${info.label}`.slice(0, 100),
            value: key,
          }))
        )
    )
    .addBooleanOption(opt =>
      opt
        .setName('public')
        .setDescription('チャンネル全員に表示するか（デフォルト: False / 自分だけに表示）')
        .setRequired(false)
    ),
  selectMenuPrefixes: ['help_select_'],

  async execute(interaction) {
    const category = interaction.options.getString('category');
    const isPublic = interaction.options.getBoolean('public') ?? false;
    const replyOpts = isPublic ? {} : { flags: MessageFlags.Ephemeral };

    const selected = category && COMMAND_DETAILS[category] ? category : 'overview';
    const embed = selected === 'overview' ? buildOverviewEmbed() : buildDetailEmbed(selected);

    return interaction.reply({
      embeds: [embed],
      components: [buildSelectRow(selected)],
      ...replyOpts,
    });
  },

  async handleSelectMenu(interaction) {
    const selected = interaction.values[0];
    const embed = selected === 'overview' || !COMMAND_DETAILS[selected]
      ? buildOverviewEmbed()
      : buildDetailEmbed(selected);

    return interaction.update({
      embeds: [embed],
      components: [buildSelectRow(selected)],
    });
  },
};
