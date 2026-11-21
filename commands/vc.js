const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { shuffleArray } = require('../lib/utils');
const { gatherMembersToVoice, buildGatherResultEmbed } = require('../lib/voice');

module.exports = {
  data: new SlashCommandBuilder()
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
    )
    .addSubcommand(sub =>
      sub
        .setName('mute')
        .setDescription('VCにいるメンバー（実行者とBotを除く）を一斉サーバーミュートします')
        .addChannelOption(opt =>
          opt
            .setName('target')
            .setDescription('対象のVC（省略時はあなたが現在いるVC）')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('include_self')
            .setDescription('実行者（あなた自身）もミュートするか（デフォルト: False）')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('include_bots')
            .setDescription('Botもミュートするか（デフォルト: False）')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('unmute')
        .setDescription('VCにいるメンバーのサーバーミュートを一斉解除します')
        .addChannelOption(opt =>
          opt
            .setName('target')
            .setDescription('対象のVC（省略時はあなたが現在いるVC）')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('include_bots')
            .setDescription('Botのミュートも解除するか（デフォルト: False）')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('split')
        .setDescription('VCのメンバーをランダムに組分けして密談VCへ一斉振り分けします')
        .addIntegerOption(opt =>
          opt
            .setName('size')
            .setDescription('1グループあたりの人数（デフォルト: 2人ペア。1人余る場合は最後の組に合流）')
            .setMinValue(2)
            .setMaxValue(10)
            .setRequired(false)
        )
        .addChannelOption(opt =>
          opt
            .setName('source')
            .setDescription('振り分け元のVC（省略時はあなたが現在いるVC）')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('include_self')
            .setDescription('実行者（あなた自身）も振り分け対象に含めるか（GMレス時は True / デフォルト: False）')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('same_category')
            .setDescription('同じカテゴリー内の他VCのみを振り分け先にするか（デフォルト: True）')
            .setRequired(false)
        )
    ),
  buttonPrefixes: ['vc_gather_'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'gather') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers)) {
        return interaction.reply({
          content: '❌ このコマンドを実行するには「メンバーを移動（Move Members）」権限が必要です。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const botMember = interaction.guild.members.me;
      if (!botMember?.permissions.has(PermissionFlagsBits.MoveMembers)) {
        return interaction.reply({
          content: '❌ Botに「メンバーを移動（Move Members）」権限がありません。サーバー設定またはロール設定でBotに権限を付与してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

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

      await interaction.deferReply();

      const gatherResult = await gatherMembersToVoice({
        guild: interaction.guild,
        targetChannel,
        requestedByTag: interaction.user.tag,
        sameCategory,
        includeBots,
      });

      if (gatherResult.totalTargets === 0) {
        return interaction.editReply({
          content: `ℹ️ ${gatherResult.scopeLabel}に移動対象のメンバーはいませんでした。`,
        });
      }

      const embed = buildGatherResultEmbed({ targetChannel, ...gatherResult, sameCategory });
      console.log(`[VC Gather] ${gatherResult.movedCount}名を「${targetChannel.name}」に移動しました。`);
      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'mute' || sub === 'unmute') {
      const isMute = sub === 'mute';

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.MuteMembers)) {
        return interaction.reply({
          content: '❌ このコマンドを実行するには「メンバーをミュート（Mute Members）」権限が必要です。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const botMember = interaction.guild.members.me;
      if (!botMember?.permissions.has(PermissionFlagsBits.MuteMembers)) {
        return interaction.reply({
          content: '❌ Botに「メンバーをミュート（Mute Members）」権限がありません。サーバー設定またはロール設定でBotに権限を付与してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const targetOption = interaction.options.getChannel('target');
      const targetChannel = targetOption || interaction.member.voice?.channel;
      if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
        return interaction.reply({
          content: '❌ 対象のVCが見つかりません。VCに入ってから実行するか、`target` オプションでVCを指定してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const includeSelf = isMute ? (interaction.options.getBoolean('include_self') ?? false) : true;
      const includeBots = interaction.options.getBoolean('include_bots') ?? false;

      const targets = [];
      for (const [, member] of targetChannel.members) {
        if (!includeBots && member.user.bot) continue;
        if (!includeSelf && member.id === interaction.user.id) continue;
        if (isMute && member.voice.serverMute) continue;
        if (!isMute && !member.voice.serverMute) continue;
        targets.push(member);
      }

      if (targets.length === 0) {
        return interaction.reply({
          content: isMute
            ? `ℹ️ 「**${targetChannel.name}**」に新しくミュートする対象メンバーはいませんでした。`
            : `ℹ️ 「**${targetChannel.name}**」にサーバーミュート中のメンバーはいませんでした。`,
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      const results = await Promise.allSettled(
        targets.map(async member => {
          await member.voice.setMute(isMute, `VC一斉${isMute ? 'ミュート' : 'ミュート解除'} (/vc ${sub} by ${interaction.user.tag})`);
          return member.displayName;
        })
      );

      const succeeded = [];
      const failed = [];
      results.forEach((res, i) => {
        if (res.status === 'fulfilled') succeeded.push(res.value);
        else failed.push(targets[i].displayName);
      });

      const embed = new EmbedBuilder()
        .setTitle(
          isMute
            ? `🔇 「${targetChannel.name}」のメンバーを一斉ミュートしました`
            : `🔊 「${targetChannel.name}」のメンバーのミュートを解除しました`
        )
        .setColor(isMute ? 0xE67E22 : 0x2ECC71)
        .setDescription(
          succeeded.length > 0
            ? `対象メンバー (${succeeded.length}名):\n${succeeded.map(n => `・${n}`).join('\n')}`
            : '対象メンバーを処理できませんでした。'
        )
        .setFooter({
          text: isMute
            ? `解除するときは /vc unmute を実行してください${failed.length > 0 ? ` ｜ 失敗: ${failed.length}名` : ''}`
            : `完了: ${succeeded.length}名${failed.length > 0 ? ` ｜ 失敗: ${failed.length}名` : ''}`,
        })
        .setTimestamp();

      if (failed.length > 0) {
        embed.addFields({ name: '⚠️ 変更できなかったメンバー', value: failed.join(', ') });
      }

      console.log(`[VC ${isMute ? 'Mute' : 'Unmute'}] ${succeeded.length}名を変更しました（${targetChannel.name}）。`);
      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'split') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers)) {
        return interaction.reply({
          content: '❌ このコマンドを実行するには「メンバーを移動（Move Members）」権限が必要です。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const botMember = interaction.guild.members.me;
      if (!botMember?.permissions.has(PermissionFlagsBits.MoveMembers)) {
        return interaction.reply({
          content: '❌ Botに「メンバーを移動（Move Members）」権限がありません。サーバー設定またはロール設定でBotに権限を付与してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const sourceOption = interaction.options.getChannel('source');
      const sourceChannel = sourceOption || interaction.member.voice?.channel;
      if (!sourceChannel || sourceChannel.type !== ChannelType.GuildVoice) {
        return interaction.reply({
          content: '❌ 振り分け元のVCが見つかりません。VCに入ってから実行するか、`source` オプションでVCを指定してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const groupSize = interaction.options.getInteger('size') ?? 2;
      const includeSelf = interaction.options.getBoolean('include_self') ?? false;
      const sameCategory = interaction.options.getBoolean('same_category') ?? true;

      const humanMembers = [...sourceChannel.members.values()].filter(m => {
        if (m.user.bot) return false;
        if (!includeSelf && m.id === interaction.user.id) return false;
        return true;
      });

      if (humanMembers.length < 2) {
        return interaction.reply({
          content: `❌ 振り分け対象のメンバーが2名以上必要です（現在: ${humanMembers.length}名）。\nGMレス進行の場合は \`include_self:True\` を指定してください。`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const shuffled = shuffleArray(humanMembers);
      const groups = [];
      for (let i = 0; i < shuffled.length; i += groupSize) {
        groups.push(shuffled.slice(i, i + groupSize));
      }
      if (groups.length >= 2 && groups[groups.length - 1].length === 1) {
        const solo = groups.pop()[0];
        groups[groups.length - 1].push(solo);
      }

      const afkChannelId = interaction.guild.afkChannelId;
      const destChannels = [...interaction.guild.channels.cache.values()]
        .filter(ch => {
          if (ch.type !== ChannelType.GuildVoice) return false;
          if (ch.id === sourceChannel.id) return false;
          if (afkChannelId && ch.id === afkChannelId) return false;
          if (sameCategory && sourceChannel.parentId && ch.parentId !== sourceChannel.parentId) return false;
          return true;
        })
        .sort((a, b) => a.rawPosition - b.rawPosition);

      if (destChannels.length < groups.length) {
        return interaction.reply({
          content: `❌ 振り分け先の密談VCが足りません（必要: **${groups.length}個** / 利用可能: **${destChannels.length}個**）。\n同じカテゴリー内に密談用VCを追加するか、\`size\` を大きくしてください。`,
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      const moveJobs = [];
      const groupAssignments = groups.map((members, i) => {
        const destCh = destChannels[i];
        members.forEach(member => moveJobs.push({ member, destCh }));
        return { destCh, members };
      });

      const results = await Promise.allSettled(
        moveJobs.map(async ({ member, destCh }) => {
          await member.voice.setChannel(destCh, `密談VC振り分け (/vc split by ${interaction.user.tag})`);
          return member.displayName;
        })
      );

      const failed = [];
      results.forEach((res, i) => {
        if (res.status === 'rejected') failed.push(moveJobs[i].member.displayName);
      });

      const assignmentLines = groupAssignments.map(({ destCh, members }, idx) =>
        `**組${idx + 1}** 🔊 **${destCh.name}**\n└ ${members.map(m => m.displayName).join(' / ')}`
      );

      const embed = new EmbedBuilder()
        .setTitle(`🔀 密談VCへランダム振り分けしました！（${groups.length}組）`)
        .setColor(0x9B59B6)
        .setDescription(assignmentLines.join('\n\n'))
        .setFooter({
          text: `移動完了: ${moveJobs.length - failed.length}名${failed.length > 0 ? ` / 失敗: ${failed.length}名` : ''} ｜ 終わったら下のボタンで全員集合できます`,
        })
        .setTimestamp();

      if (failed.length > 0) {
        embed.addFields({ name: '⚠️ 移動できなかったメンバー', value: failed.join(', ') });
      }

      const gatherRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`vc_gather_${sourceChannel.id}`)
          .setLabel(`全員を「${sourceChannel.name}」に集合させる`.slice(0, 80))
          .setEmoji('📢')
          .setStyle(ButtonStyle.Primary)
      );

      console.log(`[VC Split] ${moveJobs.length - failed.length}名を${groups.length}つの密談VCに振り分けました。`);
      return interaction.editReply({ embeds: [embed], components: [gatherRow] });
    }
  },

  async handleButton(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers)) {
      return interaction.reply({
        content: '❌ このボタンを操作するには「メンバーを移動（Move Members）」権限が必要です。',
        flags: MessageFlags.Ephemeral,
      });
    }

    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.MoveMembers)) {
      return interaction.reply({
        content: '❌ Botに「メンバーを移動（Move Members）」権限がありません。サーバー設定またはロール設定でBotに権限を付与してください。',
        flags: MessageFlags.Ephemeral,
      });
    }

    const targetId = interaction.customId.replace('vc_gather_', '');
    const targetChannel = targetId !== 'caller'
      ? (interaction.guild.channels.cache.get(targetId) || interaction.member.voice?.channel)
      : interaction.member.voice?.channel;

    if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
      return interaction.reply({
        content: '❌ 集合先のVCが見つかりません。集合先のVCに入ってからボタンを押してください。',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    const gatherResult = await gatherMembersToVoice({
      guild: interaction.guild,
      targetChannel,
      requestedByTag: interaction.user.tag,
      sameCategory: true,
      includeBots: false,
    });

    if (gatherResult.totalTargets === 0) {
      return interaction.editReply({
        content: `ℹ️ ${gatherResult.scopeLabel}に移動対象のメンバーはいませんでした。`,
      });
    }

    const embed = buildGatherResultEmbed({ targetChannel, ...gatherResult, sameCategory: true });
    console.log(`[VC Gather Button] ${gatherResult.movedCount}名を「${targetChannel.name}」に移動しました。`);
    return interaction.editReply({ embeds: [embed] });
  },
};
