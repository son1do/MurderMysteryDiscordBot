const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const { lastCharResults, getSavedNickMap } = require('../lib/state');

function formatCharacterNick(charName, baseName, format = 'both') {
  if (format === 'char_only') {
    return charName.slice(0, 32);
  }
  const suffix = `（${baseName}）`;
  const combined = `${charName}${suffix}`;
  if (combined.length <= 32) return combined;
  const maxCharLen = Math.max(1, 32 - suffix.length);
  return `${charName.slice(0, maxCharLen)}${suffix}`.slice(0, 32);
}

async function applyCharacterNicknames({ guild, assignments, format = 'both', requestedByTag }) {
  const savedMap = getSavedNickMap(guild.id);
  const succeeded = [];
  const failed = [];

  await Promise.allSettled(
    assignments.map(async ({ userId, charName }) => {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        failed.push({ name: `<@${userId}>`, reason: 'メンバーが見つかりません' });
        return;
      }

      if (!savedMap.has(userId)) {
        savedMap.set(userId, {
          originalNick: member.nickname,
          originalDisplayName: member.displayName,
        });
      }
      const baseName = savedMap.get(userId).originalDisplayName;
      const newNick = formatCharacterNick(charName, baseName, format);

      try {
        await member.setNickname(newNick, `マダミス配役ニックネーム変更 (by ${requestedByTag})`);
        succeeded.push({ baseName, newNick });
      } catch (err) {
        const reason = member.id === guild.ownerId
          ? 'サーバー所有者のためBotから変更不可'
          : 'Botより上位のロールを持つため変更不可';
        failed.push({ name: baseName, newNick, reason });
      }
    })
  );

  return { succeeded, failed };
}

function buildNickAppliedEmbed(succeeded, failed) {
  const embed = new EmbedBuilder()
    .setTitle('🏷️ ニックネームをキャラクター名に変更しました！')
    .setColor(0x2ECC71)
    .setDescription(
      succeeded.length > 0
        ? succeeded.map(s => `・${s.baseName} → **${s.newNick}**`).join('\n')
        : '変更できたメンバーはいませんでした。'
    )
    .setFooter({ text: 'セッション終了後は /nick reset で全員元の名前に戻せます' })
    .setTimestamp();

  if (failed.length > 0) {
    embed.addFields({
      name: '⚠️ 自動変更できなかったメンバー（手動変更をお願いします）',
      value: failed.map(f => `・${f.name}${f.newNick ? ` → \`${f.newNick}\`` : ''}（${f.reason}）`).join('\n').slice(0, 1024),
    });
  }
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nick')
    .setDescription('キャラクター名へニックネームを一括変更＆終了後に元の名前へ復元します')
    .addSubcommand(sub =>
      sub
        .setName('from-char')
        .setDescription('直近の /char 配役確定結果をもとに全員のニックネームを一括変更します')
        .addStringOption(opt =>
          opt
            .setName('format')
            .setDescription('表示形式（デフォルト: キャラ名（元名））')
            .setRequired(false)
            .addChoices(
              { name: 'キャラ名（元の名前） 例: 探偵（田中）', value: 'both' },
              { name: 'キャラ名のみ 例: 探偵', value: 'char_only' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription('指定メンバーのニックネームをキャラ名に変更します（元の名前は自動保存）')
        .addUserOption(opt =>
          opt.setName('user').setDescription('対象メンバー').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('character').setDescription('キャラクター名').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('format')
            .setDescription('表示形式（デフォルト: キャラ名（元名））')
            .setRequired(false)
            .addChoices(
              { name: 'キャラ名（元の名前） 例: 探偵（田中）', value: 'both' },
              { name: 'キャラ名のみ 例: 探偵', value: 'char_only' }
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('reset').setDescription('このBotで変更した全員のニックネームを元の名前に一括復元します')
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('現在復元対象として保存されているメンバー一覧を表示します')
    ),
  buttonPrefixes: ['nick_apply_char'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'list') {
      const savedMap = getSavedNickMap(guildId);
      if (savedMap.size === 0) {
        return interaction.reply({
          content: '📋 現在、元に戻す対象のニックネームは保存されていません。',
          flags: MessageFlags.Ephemeral,
        });
      }
      const lines = [...savedMap.entries()].map(
        ([uid, info]) => `・<@${uid}>（元の名前: **${info.originalDisplayName}**）`
      );
      const embed = new EmbedBuilder()
        .setTitle('🏷️ ニックネーム変更中メンバー（復元対象）')
        .setDescription(lines.join('\n').slice(0, 4000))
        .setColor(0x3498DB)
        .setFooter({ text: '/nick reset で全員のニックネームを元に戻せます' })
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames)) {
      return interaction.reply({
        content: '❌ このコマンドを実行するには「ニックネームの管理（Manage Nicknames）」権限が必要です。',
        flags: MessageFlags.Ephemeral,
      });
    }
    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      return interaction.reply({
        content: '❌ Botに「ニックネームの管理（Manage Nicknames）」権限がありません。サーバー設定またはロール設定でBotに権限を付与してください。',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'from-char') {
      const assignments = lastCharResults.get(guildId);
      if (!assignments || assignments.length === 0) {
        return interaction.reply({
          content: '❌ 直近の `/char` 配役確定結果が見つかりません。先に `/char start` → 配役確定を行うか、`/nick set` で個別に設定してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const format = interaction.options.getString('format') || 'both';
      await interaction.deferReply();

      const { succeeded, failed } = await applyCharacterNicknames({
        guild: interaction.guild,
        assignments,
        format,
        requestedByTag: interaction.user.tag,
      });

      console.log(`[Nick] ${succeeded.length}名のニックネームを変更しました（失敗: ${failed.length}名）。`);
      return interaction.editReply({ embeds: [buildNickAppliedEmbed(succeeded, failed)] });
    }

    if (sub === 'set') {
      const targetUser = interaction.options.getUser('user');
      const charName = interaction.options.getString('character').trim();
      const format = interaction.options.getString('format') || 'both';

      await interaction.deferReply();

      const { succeeded, failed } = await applyCharacterNicknames({
        guild: interaction.guild,
        assignments: [{ userId: targetUser.id, charName }],
        format,
        requestedByTag: interaction.user.tag,
      });

      if (succeeded.length > 0) {
        const s = succeeded[0];
        return interaction.editReply({
          content: `🏷️ **${s.baseName}** のニックネームを **${s.newNick}** に変更しました！（元に戻すときは \`/nick reset\`）`,
        });
      }
      const f = failed[0];
      return interaction.editReply({
        content: `⚠️ **${f?.name || targetUser.username}** のニックネームを変更できませんでした（${f?.reason || '権限不足'}）。${f?.newNick ? `\n手動で \`${f.newNick}\` に変更してください。` : ''}`,
      });
    }

    if (sub === 'reset') {
      const savedMap = getSavedNickMap(guildId);
      if (savedMap.size === 0) {
        return interaction.reply({
          content: 'ℹ️ 元に戻す対象のニックネームはありません。',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      const restored = [];
      const failed = [];
      const entries = [...savedMap.entries()];

      await Promise.allSettled(
        entries.map(async ([userId, info]) => {
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!member) {
            savedMap.delete(userId);
            return;
          }
          try {
            await member.setNickname(info.originalNick, `マダミス終了・ニックネーム復元 (by ${interaction.user.tag})`);
            restored.push(info.originalDisplayName);
            savedMap.delete(userId);
          } catch (err) {
            failed.push(info.originalDisplayName);
          }
        })
      );

      const embed = new EmbedBuilder()
        .setTitle('🔄 ニックネームを元の名前に復元しました！')
        .setColor(0x3498DB)
        .setDescription(
          restored.length > 0
            ? `復元完了 (${restored.length}名):\n${restored.map(n => `・${n}`).join('\n')}`
            : '復元できたメンバーはいませんでした。'
        )
        .setTimestamp();

      if (failed.length > 0) {
        embed.addFields({ name: '⚠️ 復元できなかったメンバー', value: failed.join(', ') });
      }

      console.log(`[Nick Reset] ${restored.length}名のニックネームを復元しました。`);
      return interaction.editReply({ embeds: [embed] });
    }
  },

  async handleButton(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames)) {
      return interaction.reply({
        content: '❌ このボタンを操作するには「ニックネームの管理（Manage Nicknames）」権限が必要です。',
        flags: MessageFlags.Ephemeral,
      });
    }
    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      return interaction.reply({
        content: '❌ Botに「ニックネームの管理（Manage Nicknames）」権限がありません。サーバー設定またはロール設定でBotに権限を付与してください。',
        flags: MessageFlags.Ephemeral,
      });
    }

    const assignments = lastCharResults.get(interaction.guildId);
    if (!assignments || assignments.length === 0) {
      return interaction.reply({
        content: '❌ 配役データが見つかりませんでした。`/nick set` で個別に設定してください。',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    const { succeeded, failed } = await applyCharacterNicknames({
      guild: interaction.guild,
      assignments,
      format: 'both',
      requestedByTag: interaction.user.tag,
    });

    console.log(`[Nick Button] ${succeeded.length}名のニックネームを変更しました（失敗: ${failed.length}名）。`);
    return interaction.editReply({ embeds: [buildNickAppliedEmbed(succeeded, failed)] });
  },
};
