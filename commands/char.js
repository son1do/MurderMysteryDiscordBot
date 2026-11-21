const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { lastCharResults } = require('../lib/state');
const { VOTE_NUMBERS, shuffleArray } = require('../lib/utils');

const charSessions = new Map();

class CharSession {
  constructor({ guildId, title, characters, startedBy, isSecret = false }) {
    this.guildId = guildId;
    this.title = title;
    this.characters = characters;
    this.startedBy = startedBy;
    this.isSecret = isSecret;
    this.round = 1;
    this.assigned = characters.map(() => null);
    this.selections = new Map();
    this.waitingUsers = new Map();
    this.lotteryLogs = [];
    this.lastRoundLogs = [];
    this.message = null;
    this.isOpen = true;
  }

  getAssignedCharacter(userId) {
    const idx = this.assigned.findIndex(a => a && a.id === userId);
    return idx !== -1 ? this.characters[idx] : null;
  }

  setSelection(userId, name, choice) {
    const prev = this.selections.get(userId);
    this.selections.set(userId, { name, choice });
    return Boolean(prev);
  }

  removeSelection(userId) {
    return this.selections.delete(userId);
  }

  resolveRound() {
    const applicantsByChar = this.characters.map(() => []);
    const anyApplicants = [];

    for (const [userId, { name, choice }] of this.selections.entries()) {
      if (this.getAssignedCharacter(userId)) continue;
      if (choice === 'any') {
        anyApplicants.push({ id: userId, name });
      } else if (applicantsByChar[choice] && !this.assigned[choice]) {
        applicantsByChar[choice].push({ id: userId, name });
      }
    }

    const roundLogs = [];
    const losers = [];

    applicantsByChar.forEach((list, idx) => {
      if (this.assigned[idx]) return;
      if (list.length === 1) {
        this.assigned[idx] = { ...list[0], reason: `✅ 第${this.round}R希望通り` };
        this.selections.delete(list[0].id);
        this.waitingUsers.delete(list[0].id);
      } else if (list.length > 1) {
        const shuffled = shuffleArray(list);
        const winner = shuffled[0];
        this.assigned[idx] = { ...winner, reason: `🎰 第${this.round}R抽選当選` };
        this.selections.delete(winner.id);
        this.waitingUsers.delete(winner.id);

        const log = `・**${this.characters[idx]}**（${list.map(u => u.name).join(' vs ')}）→ 🎉 **${winner.name}**`;
        roundLogs.push(log);
        this.lotteryLogs.push(`[第${this.round}R] ${log}`);

        for (let i = 1; i < shuffled.length; i++) {
          const loser = shuffled[i];
          this.selections.delete(loser.id);
          this.waitingUsers.set(loser.id, loser.name);
          losers.push(loser);
        }
      }
    });

    const remainingCharIndices = [];
    this.assigned.forEach((a, idx) => {
      if (!a) remainingCharIndices.push(idx);
    });

    const needsNextRound = losers.length > 0 && remainingCharIndices.length >= 2;
    if (needsNextRound) {
      this.lastRoundLogs = roundLogs;
      this.round += 1;
      return { completed: false, roundLogs, losers, overflowUsers: [] };
    }

    const finalPool = [...losers, ...anyApplicants];
    const shuffledPool = shuffleArray(finalPool);
    const shuffledChars = shuffleArray(remainingCharIndices);
    const overflowUsers = [];

    shuffledPool.forEach((user, i) => {
      this.selections.delete(user.id);
      this.waitingUsers.delete(user.id);
      if (i < shuffledChars.length) {
        const charIdx = shuffledChars[i];
        const wasAny = anyApplicants.some(u => u.id === user.id);
        this.assigned[charIdx] = {
          ...user,
          reason: wasAny ? '🎲 おまかせ割当' : '🔄 残り枠自動確定',
        };
      } else {
        overflowUsers.push(user);
      }
    });

    this.lastRoundLogs = roundLogs;
    return { completed: true, roundLogs, losers, overflowUsers };
  }

  buildPickingEmbed() {
    const assignedCount = this.assigned.filter(Boolean).length;
    const pendingPickCount = this.selections.size;
    const embed = new EmbedBuilder()
      .setTitle(`🎭 ${this.title}（第${this.round}ラウンド）`)
      .setColor(0x9B59B6)
      .setTimestamp();

    const applicantsByChar = this.characters.map(() => []);
    const anyList = [];
    for (const [, { name, choice }] of this.selections.entries()) {
      if (choice === 'any') anyList.push(name);
      else if (applicantsByChar[choice]) applicantsByChar[choice].push(name);
    }

    const charLines = this.characters.map((c, i) => {
      const fixed = this.assigned[i];
      if (fixed) {
        return `${VOTE_NUMBERS[i] ?? `**${i + 1}.**`} ~~${c}~~ → 🔒 **${fixed.name}** *(${fixed.reason})*`;
      }
      if (this.isSecret) {
        return `${VOTE_NUMBERS[i] ?? `**${i + 1}.**`} **${c}** （募集中）`;
      }
      const list = applicantsByChar[i];
      const badge = list.length === 0
        ? '（空き）'
        : list.length === 1
          ? `→ ${list[0]}`
          : `→ ⚠️ **抽選 (${list.length}名)**: ${list.join(', ')}`;
      return `${VOTE_NUMBERS[i] ?? `**${i + 1}.**`} **${c}** ${badge}`;
    }).join('\n');

    const anyLine = !this.isSecret && anyList.length > 0 ? `\n🎲 **おまかせ**: ${anyList.join(', ')}` : '';
    const waitingLine = this.waitingUsers.size > 0
      ? `\n\n🔁 **選び直し待ち**: ${[...this.waitingUsers.keys()].map(id => `<@${id}>`).join(', ')}`
      : '';

    const intro = this.round === 1
      ? `希望するキャラクターのボタンを押してください${this.isSecret ? '（**希望は非公開**）' : ''}。\n被ったキャラは抽選し、外れた人は次ラウンドで残りのキャラから選び直せます！`
      : '抽選で外れた方は、残っている空きキャラから改めて希望を選んでください！';

    embed
      .setDescription(
        `${intro}\n\n${charLines}${anyLine}${waitingLine}\n\n` +
        `📊 確定: **${assignedCount}名** / 今回希望済み: **${pendingPickCount}名**（全${this.characters.length}キャラ）`
      )
      .setFooter({ text: '別ボタンを押すと希望を変更できます ｜ GMが確定ボタンで抽選＆次ラウンドへ' });

    if (this.lastRoundLogs.length > 0) {
      embed.addFields({
        name: `🎰 第${this.round - 1}ラウンド抽選結果`,
        value: this.lastRoundLogs.join('\n').slice(0, 1024),
      });
    }

    return embed;
  }

  buildResultEmbed(overflowUsers = []) {
    const resultLines = this.characters.map((c, i) => {
      const a = this.assigned[i];
      if (!a) return `${VOTE_NUMBERS[i] ?? `**${i + 1}.**`} **${c}** → （未割当）`;
      return `${VOTE_NUMBERS[i] ?? `**${i + 1}.**`} **${c}** → **${a.name}** (<@${a.id}>)　*${a.reason}*`;
    }).join('\n');

    const assignedCount = this.assigned.filter(Boolean).length;
    const embed = new EmbedBuilder()
      .setTitle(`🎭 ${this.title} — 配役確定！`)
      .setColor(0x2ECC71)
      .setDescription(resultLines)
      .setFooter({ text: `確定 ${assignedCount} / ${this.characters.length}キャラ（全${this.round}ラウンド）` })
      .setTimestamp();

    if (this.lotteryLogs.length > 0) {
      embed.addFields({ name: '🎰 抽選履歴', value: this.lotteryLogs.join('\n').slice(0, 1024) });
    }
    if (overflowUsers.length > 0) {
      embed.addFields({
        name: '⚠️ 枠外（キャラ数より希望者が多かったメンバー）',
        value: overflowUsers.map(u => `${u.name} (<@${u.id}>)`).join(', '),
      });
    }
    return embed;
  }

  buildButtonRows(disabled = false) {
    const rows = [];
    for (let i = 0; i < this.characters.length; i += 5) {
      const slice = this.characters.slice(i, i + 5);
      const row = new ActionRowBuilder();
      slice.forEach((c, offset) => {
        const idx = i + offset;
        const isTaken = Boolean(this.assigned[idx]);
        const btn = new ButtonBuilder()
          .setCustomId(`char_pick_${idx}`)
          .setLabel(isTaken ? `${c} (済)`.slice(0, 80) : c.slice(0, 80))
          .setStyle(isTaken ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(disabled || isTaken);
        if (VOTE_NUMBERS[idx]) btn.setEmoji(VOTE_NUMBERS[idx]);
        row.addComponents(btn);
      });
      rows.push(row);
    }

    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('char_pick_any')
        .setLabel('おまかせ')
        .setEmoji('🎲')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('char_unpick')
        .setLabel('取消')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('char_resolve')
        .setLabel('抽選・確定 (GM)')
        .setEmoji('🎯')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('char_cancel')
        .setLabel('中止 (GM)')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    );
    rows.push(controlRow);
    return rows;
  }
}

function buildNickApplyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('nick_apply_char')
      .setLabel('ニックネームをキャラ名に変更 (GM)')
      .setEmoji('🏷️')
      .setStyle(ButtonStyle.Primary)
  );
}

function saveCharResultsForNick(guildId, session) {
  const savedAssignments = [];
  session.assigned.forEach((a, i) => {
    if (a) savedAssignments.push({ userId: a.id, charName: session.characters[i] });
  });
  if (savedAssignments.length > 0) lastCharResults.set(guildId, savedAssignments);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('char')
    .setDescription('キャラクター配役・重複自動抽選を行います')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('キャラクター希望選択パネルを作成します')
        .addStringOption(opt =>
          opt
            .setName('characters')
            .setDescription('キャラクター名をカンマ区切りで指定（例: 探偵,執事,メイド,医師）')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('title')
            .setDescription('タイトル（例: 狂気山脈 配役決め）。省略時は「キャラクター配役決め」')
            .setRequired(false)
        )
        .addBooleanOption(opt =>
          opt
            .setName('secret')
            .setDescription('誰がどのキャラを希望したか確定まで隠すか（デフォルト: False / 公開）')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('resolve').setDescription('希望を締め切り、配役確定＆重複抽選を実行します（作成者のみ）')
    )
    .addSubcommand(sub =>
      sub.setName('cancel').setDescription('進行中の配役決めを中止します（作成者のみ）')
    ),
  buttonPrefixes: ['char_'],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'start') {
      if (charSessions.has(guildId)) {
        return interaction.reply({
          content: '⚠️ すでに進行中の配役決めがあります。先に確定するか `/char cancel` で中止してください。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const rawChars = interaction.options.getString('characters');
      const characters = rawChars.split(/[,、，]/).map(s => s.trim()).filter(s => s.length > 0);
      if (characters.length < 2) {
        return interaction.reply({
          content: '❌ キャラクターは2人以上カンマ区切りで指定してください。（例: `探偵,執事,メイド,医師`）',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (characters.length > 20) {
        return interaction.reply({
          content: '❌ キャラクターは最大20人まで指定できます。',
          flags: MessageFlags.Ephemeral,
        });
      }

      const title = (interaction.options.getString('title') || 'キャラクター配役決め').trim();
      const isSecret = interaction.options.getBoolean('secret') ?? false;

      const session = new CharSession({
        guildId,
        title,
        characters,
        startedBy: interaction.user.id,
        isSecret,
      });
      charSessions.set(guildId, session);

      const replyResponse = await interaction.reply({
        embeds: [session.buildPickingEmbed()],
        components: session.buildButtonRows(false),
        withResponse: true,
      });
      session.message = replyResponse.resource.message;

      console.log(`[Char] 配役決め「${title}」（${characters.length}キャラ）を開始しました。`);
      return;
    }

    const session = charSessions.get(guildId);
    if (!session) {
      return interaction.reply({
        content: '❌ 現在進行中の配役決めはありません。',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (session.startedBy !== interaction.user.id) {
      return interaction.reply({
        content: '❌ この操作は配役決めを作成したGMのみ実行できます。',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'resolve') {
      const res = session.resolveRound();
      if (res.completed) {
        session.isOpen = false;
        charSessions.delete(guildId);
        saveCharResultsForNick(guildId, session);

        const resultEmbed = session.buildResultEmbed(res.overflowUsers);
        if (session.message) {
          await session.message.edit({ embeds: [resultEmbed], components: [buildNickApplyRow()] }).catch(console.error);
        }
        console.log(`[Char] 配役決め「${session.title}」を確定しました。`);
        return interaction.reply({
          content: `🎭 **【配役確定！】** 「${session.title}」の配役が決まりました！`,
          embeds: [resultEmbed],
        });
      } else {
        if (session.message) {
          await session.message.edit({
            embeds: [session.buildPickingEmbed()],
            components: session.buildButtonRows(false),
          }).catch(console.error);
        }
        const loserMentions = res.losers.map(u => `<@${u.id}>`).join(' ');
        return interaction.reply({
          content: `🎰 **第${session.round - 1}ラウンド抽選完了！**\n${res.roundLogs.join('\n')}\n\n🔁 ${loserMentions} さんは残りの空きキャラから希望を選び直してください！（第${session.round}ラウンド）`,
        });
      }
    }

    if (sub === 'cancel') {
      session.isOpen = false;
      charSessions.delete(guildId);
      const cancelEmbed = new EmbedBuilder()
        .setTitle(`🎭 ${session.title} — 中止`)
        .setColor(0x95A5A6)
        .setDescription('❌ この配役決めはGMにより中止されました。')
        .setTimestamp();
      if (session.message) {
        await session.message.edit({ embeds: [cancelEmbed], components: session.buildButtonRows(true) }).catch(console.error);
      }
      return interaction.reply({ content: '🗑️ 配役決めを中止しました。', flags: MessageFlags.Ephemeral });
    }
  },

  async handleButton(interaction) {
    const guildId = interaction.guildId;
    const charSession = charSessions.get(guildId);
    if (!charSession || !charSession.isOpen) {
      return interaction.reply({
        content: '❌ この配役決めはすでに終了しています。',
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = interaction.user.id;
    const displayName = interaction.member?.displayName || interaction.user.username;

    if (interaction.customId === 'char_resolve' || interaction.customId === 'char_cancel') {
      if (charSession.startedBy !== userId) {
        return interaction.reply({
          content: '❌ この操作は配役決めを作成したGMのみ実行できます。',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.customId === 'char_resolve') {
        const res = charSession.resolveRound();
        if (res.completed) {
          charSession.isOpen = false;
          charSessions.delete(guildId);
          saveCharResultsForNick(guildId, charSession);

          const resultEmbed = charSession.buildResultEmbed(res.overflowUsers);
          await interaction.update({ embeds: [resultEmbed], components: [buildNickApplyRow()] });
          await interaction.followUp({
            content: `🎭 **【配役確定！】** 「${charSession.title}」の配役が決定しました！`,
          }).catch(() => {});
          console.log(`[Char] 配役決め「${charSession.title}」を確定しました。`);
        } else {
          await interaction.update({
            embeds: [charSession.buildPickingEmbed()],
            components: charSession.buildButtonRows(false),
          });
          const loserMentions = res.losers.map(u => `<@${u.id}>`).join(' ');
          await interaction.followUp({
            content: `🎰 **第${charSession.round - 1}ラウンド抽選完了！**\n${res.roundLogs.join('\n')}\n\n🔁 ${loserMentions} さんは残りの空きキャラから希望を選び直してください！（第${charSession.round}ラウンド）`,
          }).catch(() => {});
        }
      } else {
        charSession.isOpen = false;
        charSessions.delete(guildId);
        const cancelEmbed = new EmbedBuilder()
          .setTitle(`🎭 ${charSession.title} — 中止`)
          .setColor(0x95A5A6)
          .setDescription('❌ この配役決めはGMにより中止されました。')
          .setTimestamp();
        await interaction.update({ embeds: [cancelEmbed], components: charSession.buildButtonRows(true) });
      }
      return;
    }

    const alreadyFixedChar = charSession.getAssignedCharacter(userId);
    if (alreadyFixedChar) {
      return interaction.reply({
        content: `🔒 あなたはすでに **${alreadyFixedChar}** で配役が確定しています！`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === 'char_unpick') {
      const removed = charSession.removeSelection(userId);
      await interaction.update({
        embeds: [charSession.buildPickingEmbed()],
        components: charSession.buildButtonRows(false),
      });
      await interaction.followUp({
        content: removed ? '❌ キャラクター希望を取り消しました。' : 'ℹ️ まだ希望を選択していません。',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    if (interaction.customId === 'char_pick_any') {
      const isChange = charSession.setSelection(userId, displayName, 'any');
      await interaction.update({
        embeds: [charSession.buildPickingEmbed()],
        components: charSession.buildButtonRows(false),
      });
      await interaction.followUp({
        content: isChange ? '🔄 希望を **🎲 おまかせ** に変更しました！' : '🎲 **おまかせ** で登録しました！',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    if (interaction.customId.startsWith('char_pick_')) {
      const idx = parseInt(interaction.customId.replace('char_pick_', ''), 10);
      const charName = charSession.characters[idx];
      if (charName === undefined) {
        return interaction.reply({ content: '❌ 無効なキャラクターです。', flags: MessageFlags.Ephemeral });
      }
      const isChange = charSession.setSelection(userId, displayName, idx);
      await interaction.update({
        embeds: [charSession.buildPickingEmbed()],
        components: charSession.buildButtonRows(false),
      });
      await interaction.followUp({
        content: isChange
          ? `🔄 希望キャラクターを **${charName}** に変更しました！`
          : `✅ **${charName}** を希望しました！`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  },
};
