const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getPlList } = require('../lib/state');
const { shuffleArray } = require('../lib/utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pl')
    .setDescription('PLリストを管理し、発言順シャッフルやランダム選択を行います')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('PLをリストに追加します')
        .addStringOption(opt =>
          opt.setName('name').setDescription('PL名（プレイヤー名）').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('PLをリストから削除します')
        .addStringOption(opt =>
          opt.setName('name').setDescription('削除するPL名').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('現在のPLリストを表示します')
    )
    .addSubcommand(sub =>
      sub.setName('clear').setDescription('PLリストをリセットします')
    )
    .addSubcommand(sub =>
      sub.setName('from-vc').setDescription('あなたがいるVCの全メンバー（Bot除く）をPLリストに一括登録します')
    )
    .addSubcommand(sub =>
      sub.setName('shuffle').setDescription('PLをシャッフルして発言順を表示します')
    )
    .addSubcommand(sub =>
      sub.setName('pick').setDescription('PLの中からランダムに1人選びます（ルーレット演出）')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const pls = getPlList(interaction.guildId);

    if (sub === 'add') {
      const name = interaction.options.getString('name').trim();
      if (pls.includes(name)) {
        return interaction.reply({ content: `⚠️ **${name}** はすでにリストに登録されています。`, flags: MessageFlags.Ephemeral });
      }
      if (pls.length >= 30) {
        return interaction.reply({ content: '❌ PLリストは最大30名までです。', flags: MessageFlags.Ephemeral });
      }
      pls.push(name);
      return interaction.reply({ content: `✅ **${name}** をPLリストに追加しました。（現在: ${pls.length}名）` });
    }

    if (sub === 'remove') {
      const name = interaction.options.getString('name').trim();
      const idx = pls.indexOf(name);
      if (idx === -1) {
        return interaction.reply({ content: `❌ **${name}** はPLリストに存在しません。`, flags: MessageFlags.Ephemeral });
      }
      pls.splice(idx, 1);
      return interaction.reply({ content: `🗑️ **${name}** をPLリストから削除しました。（残り: ${pls.length}名）` });
    }

    if (sub === 'list') {
      if (pls.length === 0) {
        return interaction.reply({ content: '📋 PLリストは空です。`/pl add` でPLを追加してください。', flags: MessageFlags.Ephemeral });
      }
      const embed = new EmbedBuilder()
        .setTitle('👥 現在のPLリスト')
        .setDescription(pls.map((name, i) => `**${i + 1}.** ${name}`).join('\n'))
        .setColor(0x3498DB)
        .setFooter({ text: `合計 ${pls.length} 名` })
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'clear') {
      const prevCount = pls.length;
      pls.length = 0;
      return interaction.reply({ content: `🗑️ PLリストをリセットしました。（${prevCount}名 → 0名）` });
    }

    if (sub === 'from-vc') {
      const memberVoice = interaction.member.voice;
      if (!memberVoice || !memberVoice.channel) {
        return interaction.reply({ content: '❌ あなたがボイスチャンネル（VC）に接続していません。', flags: MessageFlags.Ephemeral });
      }
      const vcNames = memberVoice.channel.members
        .filter(m => !m.user.bot)
        .map(m => m.displayName);
      if (vcNames.length === 0) {
        return interaction.reply({ content: '❌ VCにBot以外のメンバーがいません。', flags: MessageFlags.Ephemeral });
      }
      pls.length = 0;
      pls.push(...vcNames);
      const embed = new EmbedBuilder()
        .setTitle('👥 VCからPLリストを登録しました')
        .setDescription(pls.map((name, i) => `**${i + 1}.** ${name}`).join('\n'))
        .setColor(0x2ECC71)
        .setFooter({ text: `合計 ${pls.length} 名` })
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'shuffle') {
      if (pls.length < 2) {
        return interaction.reply({ content: '❌ シャッフルするにはPLが2名以上必要です。`/pl add` でPLを追加してください。', flags: MessageFlags.Ephemeral });
      }
      const shuffled = shuffleArray(pls);
      const medals = ['🥇', '🥈', '🥉'];
      const orderText = shuffled.map((name, i) => `${medals[i] ?? `**${i + 1}.**`} ${name}`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('🔀 発言順シャッフル結果')
        .setDescription(orderText)
        .setColor(0x9B59B6)
        .setFooter({ text: `${pls.length}名をシャッフルしました` })
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'pick') {
      if (pls.length === 0) {
        return interaction.reply({ content: '❌ PLリストが空です。`/pl add` でPLを追加してください。', flags: MessageFlags.Ephemeral });
      }

      const winner = pls[Math.floor(Math.random() * pls.length)];
      await interaction.deferReply();

      const delays = [220, 280, 350, 480, 650];
      for (const delay of delays) {
        const rnd = pls[Math.floor(Math.random() * pls.length)];
        const spinEmbed = new EmbedBuilder()
          .setTitle('🎰 ルーレット中...')
          .setDescription(`# ${rnd}`)
          .setColor(0xF39C12);
        await interaction.editReply({ embeds: [spinEmbed] });
        await new Promise(r => setTimeout(r, delay));
      }

      const finalEmbed = new EmbedBuilder()
        .setTitle('🎯 選ばれたPL')
        .setDescription(`# 🎉 ${winner}`)
        .setColor(0xE74C3C)
        .setFooter({ text: `${pls.length}名の中からランダムに選出` })
        .setTimestamp();
      return interaction.editReply({ embeds: [finalEmbed] });
    }
  },
};
