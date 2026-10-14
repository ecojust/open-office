/** Independent implementation of Writer's observed DOCX paper-dimension fit.
 * Numeric paper facts: LibreOffice 2c87e51eeaa2b413ff4ae097b2705eea1995d8e5,
 * i18nutil/source/utility/paper.cxx SHA-256
 * ccdc4cce3140380ab6b6f5b92a4c1cd5b7a6e66633b30bdb49957b8a0ad2aaa6.
 * Keep source row order, width before height, omitting the custom-paper row.
 * Nearby paper dimensions overlap, so sorting or preferring an exact match
 * would change the native first-match result.
 */
const PAPER_DIMENSIONS_MM100 = [
  84100, 118900, // A0
  59400, 84100, // A1
  42000, 59400, // A2
  29700, 42000, // A3
  21000, 29700, // A4
  14800, 21000, // A5
  25000, 35300, // ISOB4
  17600, 25000, // ISOB5
  21590, 27940, // Letter
  21590, 35560, // Legal
  27940, 43180, // Tabloid
  12500, 17600, // ISOB6
  22900, 32400, // EnvC4
  16200, 22900, // EnvC5
  11400, 16200, // EnvC6
  11400, 22900, // EnvC65
  11000, 22000, // EnvDL
  18000, 27000, // paper row 18
  21000, 28000, // paper row 19
  43180, 55880, // AnsiC
  55880, 86360, // AnsiD
  86360, 111760, // AnsiE
  18415, 26670, // Executive
  21590, 33020, // FanFoldGermanLegal
  9843, 19050, // EnvMonarch
  9208, 16510, // EnvPersonal
  9843, 22543, // Env9
  10478, 24130, // Env10
  11430, 26353, // Env11
  12065, 27940, // Env12
  18400, 26000, // paper row 31
  13000, 18400, // paper row 32
  14000, 20300, // paper row 33
  25700, 36400, // B4
  18200, 25700, // B5
  12800, 18200, // B6
  43180, 27940, // Ledger
  13970, 21590, // Statement
  21519, 27517, // Quarto
  25400, 35560, // 10x14
  13970, 29210, // Env14
  32400, 45800, // EnvC3
  11000, 23000, // EnvItalian
  37783, 27940, // FanFoldUS
  21590, 33020, // FanFoldGerman
  10000, 14800, // Postcard
  22860, 27940, // 9x11
  25400, 27940, // 10x11
  38100, 27940, // 15x11
  22000, 22000, // EnvInvite
  22700, 35600, // SuperA
  30500, 48700, // SuperB
  21590, 32233, // LetterPlus
  21000, 33000, // A4Plus
  20000, 14800, // DoublePostcard
  10500, 14800, // A6
  30480, 27940, // 12x11
  7400, 10500, // A7
  5200, 7400, // A8
  3700, 5200, // A9
  2600, 3700, // A10
  100000, 141400, // ISOB0
  70700, 100000, // ISOB1
  50000, 70700, // ISOB2
  35300, 50000, // ISOB3
  8800, 12500, // ISOB7
  6200, 8800, // ISOB8
  4400, 6200, // ISOB9
  3100, 4400, // ISOB10
  45800, 64800, // EnvC2
  8100, 11400, // EnvC7
  5700, 8100, // EnvC8
  22860, 30480, // ARCHA
  30480, 45720, // ARCHB
  45720, 60960, // ARCHC
  60960, 91440, // ARCHD
  91440, 121920, // ARCHE
  15750, 28000, // paper row 78
  17500, 28000, // paper row 79
  19500, 27000, // paper row 80
  19700, 27300, // paper row 81
  19050, 33866, // paper row 82
  19050, 25400, // paper row 83
  14288, 25400, // paper row 84
  15875, 25400, // paper row 85
] as const

function nativePaperTwips(twips: number): number {
  const mm100 = Math.round(twips * 127 / 72)
  const fitted = PAPER_DIMENSIONS_MM100.find(edge => Math.abs(mm100 - edge) < 44) ?? mm100
  return Math.round(fitted * 72 / 127)
}

/** Normalize a validated page dimension in points; margins never use this fit.
 * Reject native first-open results which would change again on a later reopen.
 * This is an editor compatibility boundary, not an OOXML size restriction.
 */
export function normalizePaperDimension(points: number): number {
  if (!Number.isFinite(points) || points < 0) throw Error('纸张尺寸必须是有效的非负数值。')
  const fitted = nativePaperTwips(Math.round(points * 20))
  if (nativePaperTwips(fitted) !== fitted) {
    throw Error('该纸张尺寸在保存重开后无法保持稳定，请选择标准纸型或调整尺寸。')
  }
  return fitted / 20
}
