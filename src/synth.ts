// Builds the "compare & combine" prompt. Answers are anonymised as A, B, C… so the
// combining model can't favour its own answer or a brand name.

export interface Named {
  label: string
  text: string
}

export interface Mapping {
  letter: string
  label: string
}

const MAX_CHARS = 14000

export const SYNTH_SYSTEM =
  'You compare several anonymous AI answers to the same question and combine them into one careful answer. ' +
  'Judge each answer only on its content. Do not guess which AI wrote which answer. Be concise and honest about uncertainty.'

export function shuffle<T>(list: T[], rand: () => number = Math.random): T[] {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function buildSynthesis(question: string, answers: Named[], rand?: () => number): { prompt: string; mapping: Mapping[] } {
  const order = shuffle(answers, rand)
  const mapping = order.map((a, i) => ({ letter: String.fromCharCode(65 + i), label: a.label }))
  const blocks = order
    .map((a, i) => {
      let t = a.text.trim()
      if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS) + '\n[…answer shortened…]'
      return `### Answer ${mapping[i].letter}\n<<<\n${t}\n>>>`
    })
    .join('\n\n')
  const letters = mapping.map((m) => m.letter).join(', ')
  const prompt = `Question:
<<<
${question.trim()}
>>>

There are ${order.length} answers (${letters}) from different AIs:

${blocks}

Write your reply in the same language as the question, in Markdown, with exactly these sections:

## Combined answer
The best short answer, using what is well supported across the answers. Correct anything that looks wrong.

## Strong agreement
Bullet points most or all answers agree on.

## Disagreement or uncertainty
Bullet points where the answers differ. Say who said what by letter (for example "A and C say …; B says …") and which side looks more likely and why.

## Only one answer mentioned
Useful points only one answer raised, with its letter.

## Possible errors / double-check
Claims that may be wrong, out of date, or need checking (numbers, dates, prices, laws, medical or legal points), with letters.

## Confidence
One or two sentences: how confident the combined answer is overall, and why.`
  return { prompt, mapping }
}
