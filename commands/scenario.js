const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { VOTE_NUMBERS } = require('../lib/utils');

const scenarioSearchCache = new Map();

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .trim();
}

function extractBoothItemId(urlStr) {
  const match = urlStr.match(/^https?:\/\/(?:[a-zA-Z0-9-]+\.)?booth\.pm\/(?:[a-z]{2}\/)?items\/(\d+)/i);
  return match ? match[1] : null;
}

async function fetchBoothItem(itemId) {
  const res = await fetch(`https://booth.pm/ja/items/${itemId}.json`, {
    headers: { 'User-Agent': 'MurderMysteryDiscordBot/1.0 (+https://discord.com)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`BOOTH API returned ${res.status}`);
  const data = await res.json();

  const rawDesc = (data.description || '').replace(/\r\n/g, '\n').trim();
  const description = rawDesc.length > 650 ? `${rawDesc.slice(0, 650)}…` : rawDesc;
  const imageUrl = data.images?.[0]?.original || data.images?.[0]?.resized || null;
  const tags = Array.isArray(data.tags) ? data.tags.map(t => t.name).filter(Boolean).slice(0, 8) : [];

  return {
    source: 'BOOTH',
    title: data.name || 'タイトル不明',
    url: data.url || `https://booth.pm/ja/items/${itemId}`,
    description: description || '（概要文がありません）',
    imageUrl,
    author: data.shop?.name || null,
    authorUrl: data.shop?.url || null,
    price: data.price || null,
    tags,
  };
}

async function searchBoothScenarios(query, limit = 5) {
  const fetchIdsForQuery = async q => {
    const searchUrl = `https://booth.pm/ja/search/${encodeURIComponent(q)}?sort=popular`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`BOOTH検索に失敗しました (HTTP ${res.status})`);
    const html = await res.text();

    const ids = [];
    const seen = new Set();
    const regex = /(?:data-product-id="|booth\.pm\/(?:ja\/)?items\/)(\d+)/g;
    let m;
    while ((m = regex.exec(html)) !== null && ids.length < limit) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
    return ids;
  };

  const hasKeyword = /マダミス|マーダーミステリー|murder\s*mystery/i.test(query);
  let ids = await fetchIdsForQuery(hasKeyword ? query : `マーダーミステリー ${query}`);
  if (ids.length === 0 && !hasKeyword) {
    ids = await fetchIdsForQuery(query);
  }
  if (ids.length === 0) return [];

  const settled = await Promise.allSettled(ids.map(id => fetchBoothItem(id)));
  return settled.filter(r => r.status === 'fulfilled').map(r => r.value);
}

async function fetchScenarioFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URLの形式が正しくありません。`https://...` の形式で指定してください。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('http / https のURLのみ対応しています。');
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('192.168.') || host.startsWith('10.')) {
    throw new Error('ローカルアドレスにはアクセスできません。');
  }

  const boothId = extractBoothItemId(rawUrl);
  if (boothId) return await fetchBoothItem(boothId);

  const res = await fetch(rawUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ページの取得に失敗しました (HTTP ${res.status})`);
  const html = await res.text();

  const getMeta = attrValue => {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${attrValue}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${attrValue}["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) return decodeHtmlEntities(m[1]);
    }
    return null;
  };

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = getMeta('og:title') || getMeta('twitter:title') || (titleMatch ? decodeHtmlEntities(titleMatch[1]) : parsed.hostname);
  const rawDesc = getMeta('og:description') || getMeta('twitter:description') || getMeta('description') || '';
  const description = rawDesc.length > 650 ? `${rawDesc.slice(0, 650)}…` : (rawDesc || '（概要文が取得できませんでした）');
  const imageUrl = getMeta('og:image') || getMeta('twitter:image') || null;
  const siteName = getMeta('og:site_name') || parsed.hostname;

  return {
    source: siteName,
    title,
    url: rawUrl,
    description,
    imageUrl,
    author: null,
    authorUrl: null,
    price: null,
    tags: [],
  };
}

function buildScenarioEmbed(info) {
  const embed = new EmbedBuilder()
    .setTitle(`📚 ${info.title.slice(0, 250)}`)
    .setURL(info.url)
    .setColor(0xE91E63)
    .setDescription(info.description.slice(0, 4000))
    .setFooter({ text: `出典: ${info.source} ｜ 詳細はタイトルのリンクから確認できます` })
    .setTimestamp();

  if (info.author) {
    embed.setAuthor(info.authorUrl ? { name: info.author, url: info.authorUrl } : { name: info.author });
  }
  if (info.imageUrl && /^https?:\/\//i.test(info.imageUrl)) {
    embed.setImage(info.imageUrl);
  }
  if (info.price) {
    embed.addFields({ name: '💴 価格', value: info.price, inline: true });
  }
  if (info.tags && info.tags.length > 0) {
    embed.addFields({ name: '🏷️ タグ', value: info.tags.map(t => `\`${t}\``).join(' '), inline: false });
  }
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scenario')
    .setDescription('マダミス作品のあらすじ・概要カードをチャットに投稿します')
    .addSubcommand(sub =>
      sub
        .setName('search')
        .setDescription('タイトルからBOOTHのマダミス作品を検索し、選んで概要カードを投稿します')
        .addStringOption(opt =>
          opt.setName('title').setDescription('検索したいシナリオ名（例: 狂気山脈）').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('url')
        .setDescription('BOOTH・マダミス.jp・ウズ等のURLから概要カードを生成して投稿します')
        .addStringOption(opt =>
          opt.setName('url').setDescription('作品ページのURL（https://...）').setRequired(true)
        )
        .addBooleanOption(opt =>
          opt.setName('preview').setDescription('自分だけにプレビュー表示するか（デフォルト: False / 全員に投稿）').setRequired(false)
        )
    ),
  buttonPrefixes: ['scenario_post_'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'search') {
      const titleQuery = interaction.options.getString('title').trim();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const items = await searchBoothScenarios(titleQuery, 5);
        if (items.length === 0) {
          return interaction.editReply({
            content: `❌ 「**${titleQuery}**」に一致するBOOTH作品が見つかりませんでした。\n別のキーワードで試すか、作品URLを \`/scenario url\` で指定してください。`,
          });
        }

        const now = Date.now();
        for (const [k, v] of scenarioSearchCache.entries()) {
          if (now - v.createdAt > 10 * 60 * 1000) scenarioSearchCache.delete(k);
        }

        const searchId = `${now}_${interaction.user.id.slice(-4)}`;
        scenarioSearchCache.set(searchId, { userId: interaction.user.id, items, createdAt: now });

        const listText = items.map((item, i) => {
          const authorPart = item.author ? ` / ${item.author}` : '';
          const pricePart = item.price ? ` (${item.price})` : '';
          return `${VOTE_NUMBERS[i]} **${item.title}**${authorPart}${pricePart}`;
        }).join('\n');

        const embed = new EmbedBuilder()
          .setTitle(`🔎 BOOTH検索結果: 「${titleQuery}」`)
          .setColor(0x3498DB)
          .setDescription(`チャンネルに投稿したい作品の番号ボタンを押してください：\n\n${listText}`)
          .setFooter({ text: 'この一覧はあなたにのみ表示されています（有効期限10分）' })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          items.map((_, i) =>
            new ButtonBuilder()
              .setCustomId(`scenario_post_${searchId}_${i}`)
              .setLabel(`${i + 1}番を投稿`)
              .setEmoji(VOTE_NUMBERS[i])
              .setStyle(ButtonStyle.Primary)
          )
        );

        return interaction.editReply({ embeds: [embed], components: [row] });
      } catch (err) {
        console.error('[Scenario Search Error]', err.message);
        return interaction.editReply({
          content: `❌ 検索中にエラーが発生しました（${err.message}）。URLがわかる場合は \`/scenario url\` をお試しください。`,
        });
      }
    }

    if (sub === 'url') {
      const rawUrl = interaction.options.getString('url').trim();
      const isPreview = interaction.options.getBoolean('preview') ?? false;
      await interaction.deferReply(isPreview ? { flags: MessageFlags.Ephemeral } : {});

      try {
        const info = await fetchScenarioFromUrl(rawUrl);
        const embed = buildScenarioEmbed(info);
        console.log(`[Scenario URL] 「${info.title}」の概要カードを生成しました。`);
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('[Scenario URL Error]', err.message);
        return interaction.editReply({
          content: `❌ URLから情報を取得できませんでした：${err.message}`,
        });
      }
    }
  },

  async handleButton(interaction) {
    const rest = interaction.customId.replace('scenario_post_', '');
    const lastUnderscore = rest.lastIndexOf('_');
    const searchId = rest.slice(0, lastUnderscore);
    const idx = parseInt(rest.slice(lastUnderscore + 1), 10);

    const cached = scenarioSearchCache.get(searchId);
    if (!cached || !cached.items[idx]) {
      return interaction.reply({
        content: '❌ 検索結果の有効期限が切れました。もう一度 `/scenario search` を実行してください。',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (cached.userId !== interaction.user.id) {
      return interaction.reply({
        content: '❌ 検索を実行した本人のみ選択できます。',
        flags: MessageFlags.Ephemeral,
      });
    }

    const selected = cached.items[idx];
    const embed = buildScenarioEmbed(selected);

    await interaction.channel.send({
      content: `📚 **本日遊ぶシナリオの概要**（投稿: ${interaction.user}）`,
      embeds: [embed],
    });

    scenarioSearchCache.delete(searchId);
    await interaction.update({
      content: `✅ 「**${selected.title}**」の概要カードをチャンネルに投稿しました！`,
      embeds: [],
      components: [],
    });
    console.log(`[Scenario Search] 「${selected.title}」をチャンネルに投稿しました。`);
  },
};
