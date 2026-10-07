// The default first-touch letter, shared by the company drawer and the print batch.
export function letterText(c, s = {}) {
  const first = (c.owner_name || "").split(" ")[0] || "there";
  const me = s.myName || "[Your name]", co = s.myCompany || "[Your company]", phone = s.myPhone || "[Your phone]", email = s.myEmail || "[Your email]";
  const angle = s.myAngle || "I run an operating business in your industry";
  const where = c.city || "your area";
  const tenure = c.founded ? `since ${c.founded}` : "for years";
  return `Dear ${first},

My name is ${me}. ${angle}, and I'm writing to a small number of owners whose companies I genuinely respect.

${c.name} has served ${where} ${tenure}. A reputation like that takes decades to build, and I'd like to help make sure it lasts.

If you've thought about what happens to the business when you step back — retirement, slowing down, or taking some value off the table — I'd welcome a confidential conversation. No brokers and no pressure. We keep the name and the team, and we can structure things so you're paid well over time and stay as involved as you like.

If now isn't the time, please keep this letter. I'll be in touch again in a few months.

Warm regards,
${me}
${co}
${phone} · ${email}`;
}
