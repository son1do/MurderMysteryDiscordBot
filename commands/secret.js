const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('secret')
    .setDescription('指定したメンバーにこっそり秘密メッセージ（密書）をDM送信します')
    .addUserOption(opt =>
      opt.setName('to').setDescription('送り先のメンバー').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('message').setDescription('秘密メッセージの内容').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('title').setDescription('メッセージのタイトル（例: 追加ハンドアウト、密書）').setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('anonymous').setDescription('差出人を匿名にするか（デフォルト: False）').setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('announce').setDescription('チャンネルに「密書が届いた」ことを公開通知するか（デフォルト: False）').setRequired(false)
    ),

  async execute(interaction) {
    const targetUser = interaction.options.getUser('to');
    const body = interaction.options.getString('message').trim();
    const title = (interaction.options.getString('title') || '秘密のメッセージ（密書）').trim();
    const isAnonymous = interaction.options.getBoolean('anonymous') ?? false;
    const shouldAnnounce = interaction.options.getBoolean('announce') ?? false;

    if (targetUser.bot) {
      return interaction.reply({
        content: '❌ Botには秘密メッセージを送れません。',
        flags: MessageFlags.Ephemeral,
      });
    }

    const senderName = interaction.member?.displayName || interaction.user.username;
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const targetName = targetMember?.displayName || targetUser.username;

    const dmEmbed = new EmbedBuilder()
      .setTitle(`✉️ ${title}`)
      .setColor(isAnonymous ? 0x2C3E50 : 0x9B59B6)
      .setDescription(body.slice(0, 4000))
      .addFields({
        name: '差出人',
        value: isAnonymous ? '🕵️ 匿名' : `${senderName} (${interaction.user})`,
        inline: true,
      })
      .setFooter({ text: `送信元サーバー: ${interaction.guild.name}` })
      .setTimestamp();

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await targetUser.send({ embeds: [dmEmbed] });

      console.log(`[Secret] ${senderName} -> ${targetName} へ秘密メッセージを送信しました（匿名: ${isAnonymous}）。`);

      if (shouldAnnounce) {
        interaction.channel.send({
          content: `✉️ **${targetName}** に${isAnonymous ? '誰かから' : ` **${senderName}** から`}秘密のメッセージ（${title}）が届きました…`,
        }).catch(() => {});
      }

      const confirmEmbed = new EmbedBuilder()
        .setTitle('✅ 秘密メッセージを送信しました')
        .setColor(0x2ECC71)
        .addFields(
          { name: '宛先', value: `${targetName} (${targetUser})`, inline: true },
          { name: '差出人表示', value: isAnonymous ? '🕵️ 匿名' : senderName, inline: true },
          { name: `内容（${title}）`, value: body.slice(0, 1024) }
        )
        .setFooter({ text: 'この確認メッセージはあなたにのみ表示されています' })
        .setTimestamp();

      return interaction.editReply({ embeds: [confirmEmbed] });
    } catch (err) {
      console.warn(`[Secret Error] ${targetName} へのDM送信に失敗:`, err.message);
      return interaction.editReply({
        content: `❌ **${targetName}** へのDM送信に失敗しました。\n相手が「サーバーメンバーからのダイレクトメッセージを許可する」をOFFにしている可能性があります。`,
      });
    }
  },
};
