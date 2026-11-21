const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

function rollDiceAndBuildEmbed({ user, count, sides, comment }) {
  const results = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const val = Math.floor(Math.random() * sides) + 1;
    results.push(val);
    total += val;
  }

  const formulaStr = `${count}d${sides}${comment ? ` （${comment}）` : ''}`;
  const embed = new EmbedBuilder()
    .setTitle('🎲 ダイスロール')
    .setColor(0x3498DB)
    .setTimestamp();

  if (count === 1) {
    embed.setDescription(`${user} がダイスを振りました！\n\n**【 ${formulaStr} 】**\n## 🎯 出目: \` ${total} \` / ${sides}`);
  } else {
    const rollsDisplay = results.length <= 20
      ? `[ ${results.join(', ')} ]`
      : `[ ${results.slice(0, 20).join(', ')}, ... ]`;
    embed.setDescription(`${user} がダイスを振りました！\n\n**【 ${formulaStr} 】**\n出目: \`${rollsDisplay}\`\n## 🎯 合計: \` ${total} \``);
  }
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('ダイス（サイコロ）を振ります')
    .addStringOption(opt =>
      opt
        .setName('roll')
        .setDescription('ダイスの形式（例: 1d100, 2d6, 1d6, 100）。省略時は 1d100')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt
        .setName('comment')
        .setDescription('ダイスを振る理由・項目名（例: 調査、発言順決め）')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt
        .setName('panel')
        .setDescription('自分は振らず、みんな用のダイスボタンパネルだけを表示します（デフォルト: False）')
        .setRequired(false)
    ),
  buttonPrefixes: ['dice_roll_'],

  async execute(interaction) {
    const rawRoll = interaction.options.getString('roll');
    const comment = interaction.options.getString('comment')?.trim() || null;
    const isPanel = interaction.options.getBoolean('panel') ?? false;

    if (isPanel && !rawRoll) {
      const safeComment = comment ? comment.slice(0, 60) : '';
      const suffix = safeComment ? `_${safeComment}` : '';
      const presets = [
        { label: '1d100', id: `dice_roll_1d100${suffix}` },
        { label: '1d6', id: `dice_roll_1d6${suffix}` },
        { label: '2d6', id: `dice_roll_2d6${suffix}` },
        { label: '1d20', id: `dice_roll_1d20${suffix}` },
      ];
      const row = new ActionRowBuilder().addComponents(
        presets.map(p =>
          new ButtonBuilder()
            .setCustomId(p.id)
            .setLabel(p.label)
            .setEmoji('🎲')
            .setStyle(ButtonStyle.Primary)
        )
      );
      const embed = new EmbedBuilder()
        .setTitle(`🎲 みんな用ダイス${comment ? `（${comment}）` : ''}`)
        .setDescription('下のボタンを押すと、誰でもすぐにダイスを振れます！')
        .setColor(0x3498DB)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], components: [row] });
    }

    const rollInput = (rawRoll || '1d100').trim().toLowerCase();
    let count = 1;
    let sides = 100;

    const diceMatch = rollInput.match(/^(\d*)d(\d+)$/);
    const numberMatch = rollInput.match(/^(\d+)$/);

    if (diceMatch) {
      count = diceMatch[1] ? parseInt(diceMatch[1], 10) : 1;
      sides = parseInt(diceMatch[2], 10);
    } else if (numberMatch) {
      count = 1;
      sides = parseInt(numberMatch[1], 10);
    } else {
      return interaction.reply({
        content: '❌ ダイスの形式が正しくありません。（例: `1d100`, `2d6`, `1d6`, `100`）',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (count < 1 || count > 50 || sides < 1 || sides > 10000) {
      return interaction.reply({
        content: '❌ ダイスの個数は1〜50個、面数は1〜10000面の間で指定してください。',
        flags: MessageFlags.Ephemeral,
      });
    }

    const safeComment = comment ? comment.slice(0, 60) : '';
    const buttonCustomId = `dice_roll_${count}d${sides}${safeComment ? `_${safeComment}` : ''}`;
    const diceButtonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buttonCustomId)
        .setLabel(`${count}d${sides} を振る`)
        .setEmoji('🎲')
        .setStyle(ButtonStyle.Primary)
    );

    if (isPanel) {
      const embed = new EmbedBuilder()
        .setTitle(`🎲 みんな用ダイス（${count}d${sides}${comment ? ` / ${comment}` : ''}）`)
        .setDescription(`下のボタンを押すと、誰でも **${count}d${sides}** を振れます！`)
        .setColor(0x3498DB)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], components: [diceButtonRow] });
    }

    const embed = rollDiceAndBuildEmbed({ user: interaction.user, count, sides, comment });
    return interaction.reply({ embeds: [embed], components: [diceButtonRow] });
  },

  async handleButton(interaction) {
    const match = interaction.customId.match(/^dice_roll_(\d+)d(\d+)(?:_(.*))?$/);
    if (!match) {
      return interaction.reply({
        content: '❌ ダイスボタンの情報が不正です。',
        flags: MessageFlags.Ephemeral,
      });
    }
    const count = parseInt(match[1], 10);
    const sides = parseInt(match[2], 10);
    const comment = match[3] || null;

    const embed = rollDiceAndBuildEmbed({ user: interaction.user, count, sides, comment });
    return interaction.reply({ embeds: [embed] });
  },
};
