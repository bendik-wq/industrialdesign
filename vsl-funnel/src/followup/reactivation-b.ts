import type { EmailContent, TemplateCtx } from '../integrations/templates';
import { GUIDES } from '../seo/guides';
import { type Dossier, BLOCKERS, GOALS, TIMELINES, blockerOf, industryName, peers, profitText, yourBiz } from './dossier';

/**
 * Reactivation batch B (days 14–23 of the 30-day run): the opportunity, the
 * owner's life and identity. One idea per email. Every email reads naturally
 * when any dossier field is missing; dossier text is already HTML-escaped.
 */
type T = (c: TemplateCtx, d: Dossier) => EmailContent;

const book = (c: TemplateCtx) => c.link(c.bookingUrl ? '/book' : '/breakout');
const quote = (s: string) => `<em>“${s}”</em>`;
const sizeLine = (d: Dossier) => (d.revenueLabel ? `a business doing ${d.revenueLabel.replace(/^Under /, 'under ')} in revenue` : null);
/** The industry's own guide (falls back to the general no-money-down guide). */
const guideFor = (d: Dossier) => {
  const g = d.industry ? GUIDES.find((x) => x.industry === d.industry!.id) : null;
  return g ? `/guides/${g.slug}` : '/guides/how-to-buy-a-business-with-no-money-down';
};
const isLarge = (d: Dossier) => d.revenue === 'gt10m' || d.revenue === '3_10m';
const funding = 'commercial debt, seller finance paid out of the business’s own cash flow, and seller rollover, where the owner keeps a stake';
const illustrative = 'Illustrative only. Every deal is structured on its own numbers, and nothing here is financial advice.';

export const REACTIVATE_B: Record<string, T> = {
  // ── The opportunity ──
  rb_succession: (c, d) => ({
    subject: 'who takes over when they retire?',
    preheader: d.industry ? `A lot of ${d.industry.owners} are asking themselves that.` : 'A lot of owners are asking themselves that.',
    body: [
      `${c.name}, here’s a question a lot of business owners are quietly sitting with right now: who takes over when I stop?`,
      d.industry
        ? `In ${industryName(d.industry)}, as in most industries, plenty of the people who built their ${d.industry.many} decades ago are getting close to the age where they want out. Many have no family member who wants it and no manager ready to buy it.`
        : 'In most industries, plenty of the people who built their businesses decades ago are getting close to the age where they want out. Many have no family member who wants it and no manager ready to buy it.',
      'That’s not a sad story if the right person turns up. The owner gets paid, the staff keep their jobs, the customers keep being looked after. The business just needs a successor.',
      `The successor doesn’t have to be a stranger or a fund. It can be an owner like you, down the road, who already knows the work${d.industry ? ` of running a ${d.industry.one}` : ''}.`,
      'Worth thinking about whose shoes you’d step into, if you went looking.',
    ],
    cta: { label: 'Read how to find them →', href: c.link('/guides/find-off-market-businesses-for-sale') },
  }),

  rb_organic: (c, d) => ({
    subject: 'how far organic growth gets you',
    preheader: 'One customer at a time has a speed limit.',
    body: [
      `${c.name}, a thought about how ${yourBiz(d)} grows from here.`,
      'Organic growth is the honest way to build: more marketing, more staff, more hours, a few more customers each month.',
      'It works. But it has a speed limit, and most owners hit it sooner than they expect: the next hire costs before it pays, the next market takes years to win, and you only have so many hours.',
      'Buying a business doesn’t replace organic growth. It sits on top of it. On the day a deal settles you add a customer base, a team and a profit line that took someone else twenty years to build.',
      'That’s the whole idea. Everything else, the seller conversations and the structure (commercial debt, seller finance and seller rollover), exists to make that step possible without your own cash going in.',
    ],
    cta: { label: 'Watch the short video →', href: c.link('/') },
  }),

  rb_first_mover: (c, d) => ({
    subject: 'the competitor who moves first',
    preheader: 'What happens to your market when someone else consolidates it.',
    body: [
      `${c.name}, picture this. One of your competitors buys two of the other ${peers(d)} in your area over the next few years.`,
      'Now they have more staff to cover jobs, better buying power with suppliers, a bigger marketing budget and a name more people recognise. They can quote a little sharper. They can pay your best people a little more.',
      'None of that happens overnight, and none of it means you lose. But the owner who consolidates a local market first gets the first pick of the businesses, and the rest compete with whoever they’ve become.',
      'So the useful question isn’t just “should I buy?”. It’s “who in my market is likely to, and would I rather be them?”.',
      'Reply and tell me who you think it would be. I’m curious how you see it.',
    ],
  }),

  rb_second_profit: (c, d) => ({
    subject: 'a second profit line',
    preheader: 'What it would let you do that you can’t do today.',
    body: [
      `${c.name}, forget the deal mechanics for a minute and think about what changes in your life if ${yourBiz(d)} has a second profit line next to it.`,
      d.deal
        ? `For a business your size${profitText(d) ? `, with profit ${profitText(d)}` : ''}, a sensible first target could make something like ${d.deal.targetProfit} a year (illustrative). After its repayments, that’s money you didn’t have before.`
        : 'A sensible first target is a business a little smaller than yours, with steady profit. After its repayments, what’s left is money you didn’t have before.',
      'Owners tend to do one of three things with it: hire the general manager they’ve never been able to justify, step back from the day-to-day, or simply take more home after years of reinvesting everything.',
      `And the target is funded with ${funding}, so the second line is paid for by its own profit, tested at around 1.5 times its repayments.`,
      'Which of the three would you pick?',
    ],
    cta: { label: 'See if you qualify →', href: c.link('/apply?again=1') },
    ps: illustrative,
  }),

  rb_double: (c, d) => ({
    subject: 'if your profit doubled',
    preheader: 'A question I ask every owner.',
    body: [
      `${c.name}, a question I ask almost every owner I talk to.`,
      profitText(d)
        ? `You told us ${yourBiz(d)} makes ${profitText(d)} in profit. Say that doubled. Not through more hours from you, but because a second business came under the same roof.`
        : `Say the profit from ${yourBiz(d)} doubled. Not through more hours from you, but because a second business came under the same roof.`,
      'What would you actually do with it?',
      'Most people’s first answer is about money. The second answer is the one that matters: more time with the kids, finally hiring someone to run operations, building something they could sell one day, or just not lying awake about cash flow.',
      'I’d genuinely like to know your second answer. Hit reply.',
    ],
  }),

  rb_boring: (c, d) => ({
    subject: 'the boring-business advantage',
    preheader: 'Unfashionable businesses make some of the best acquisitions.',
    body: [
      `${c.name}, the businesses that make the best first acquisitions are rarely exciting.`,
      `They’re ${d.industry ? `${d.industry.many} like yours, and the steady service businesses around them` : 'the steady service businesses: trades, clinics, cleaning, accounting, maintenance'}, with repeat customers and work that needs doing in a good year and a bad one. Their owners never thought about selling because they were too busy doing the work.`,
      'Boring is what lenders like, because steady cash flow is what repays a loan. It’s what sellers in those businesses like, because they want someone who understands the work, not a financial engineer. And it’s what you already know how to run.',
      'Nobody writes magazine stories about buying the plumbing business across town. That’s part of why the good ones are still there to buy.',
    ],
    cta: { label: 'Read the guide →', href: c.link(guideFor(d)) },
  }),

  rb_local: (c, d) => ({
    subject: 'draw a circle on the map',
    preheader: d.industry ? `How many ${d.industry.many} are inside it?` : 'How many businesses like yours are inside it?',
    body: [
      `${c.name}, try this. Open a map and draw a circle around where ${yourBiz(d)} already works.`,
      `Now count the ${peers(d)} inside that circle. Not the big players: the owner-run ones, the ones you bump into, the ones your customers mention.`,
      d.industry
        ? `Somewhere in that circle is ${d.industry.target}. Maybe a couple of them. Buying close to home means the same customers, the same suppliers, the same roads, and one set of overheads instead of two.`
        : 'Somewhere in that circle is the business down the road. Maybe a couple of them. Buying close to home means the same customers, the same suppliers, the same roads, and one set of overheads instead of two.',
      'That’s how local markets get consolidated: one owner, one circle, one deal at a time.',
      'Reply with how many you counted. I’m curious what you find.',
    ],
  }),

  rb_deal_two: (c) => ({
    subject: 'why the second deal is easier',
    preheader: 'The first one teaches you everything.',
    body: [
      `${c.name}, something owners don’t expect: the first acquisition is the hardest one they’ll ever do.`,
      'Everything is new the first time: the seller conversations, reading someone else’s books, talking to a lender about cash flow you don’t own yet, and working out who on the new team you need to sit down with on day one.',
      'By the second deal, you’ve got a lender who knows you, a structure you’ve used before, an integration plan you’ve already tested and a business with a bigger profit base behind you. What took months the first time takes weeks.',
      'Which is why the first deal matters so much. It doesn’t have to be big. It has to be sound, so it sets the pattern for the rest.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),

  // ── The owner's life ──
  rb_in_vs_on: (c, d) => ({
    subject: 'in it or on it?',
    preheader: 'Where do your hours actually go?',
    body: [
      `${c.name}, an old question but a good one: how much of your week is spent working <em>in</em> ${yourBiz(d)}, and how much <em>on</em> it?`,
      'In it is the quotes, the rosters, the phone calls nobody else can take, the job that went wrong. On it is the thinking: where the business goes next, who you hire, what you build.',
      'Most owners would love more of the second and can’t get there, because the first never stops. One answer is to hire. Another is to buy a business that comes with people already doing the work, so your role shifts from doing to deciding.',
      'Rough guess: what’s your split right now? Reply with two numbers. 80/20, 95/5, whatever’s true.',
    ],
  }),

  rb_time_back: (c, d) => {
    const time = d.blockers.includes('time');
    return {
      subject: 'buying back your week',
      preheader: 'More business, fewer hours. It sounds backwards.',
      body: [
        `${c.name},`,
        time
          ? `You told us time was one of the things in the way. That makes sense: if every hour already goes to ${yourBiz(d)}, a second business sounds like the last thing you need.`
          : 'Most owners assume a second business means a second job. It sounds like the last thing anyone needs.',
        'Here’s the part that sounds backwards. A business you buy comes with its own team, and in some cases that includes someone who has been running the day-to-day for years. Combine the two and the profit can cover the layer of management one business on its own never could.',
        'That’s how owners end up with more business and fewer hours. Not straight away, and not without work, but it’s a common shape.',
        'If buying back your week matters more to you than the money, tell me. It changes what kind of business you’d look for.',
      ],
      cta: { label: 'Book a call →', href: book(c) },
    };
  },

  rb_gm: (c, d) => ({
    subject: 'the manager you can’t justify yet',
    preheader: 'Sometimes the maths only works at twice the size.',
    body: [
      `${c.name}, plenty of owners know exactly who they need: a general manager who can run ${yourBiz(d)} so they don’t have to.`,
      'The problem is the maths. A good GM is a serious salary, and at one business’s profit it can feel like paying yourself less to work a bit less.',
      'At twice the size, the same salary is spread across two profit lines. The role becomes affordable, and it becomes necessary, because no one person runs two businesses alone. Sometimes the business you buy already has that person in it.',
      'If hiring a GM has been on your list for years, an acquisition can be the thing that finally pays for it.',
    ],
    cta: { label: 'See if you qualify →', href: c.link('/apply?again=1') },
  }),

  rb_take_home: (c) => ({
    subject: 'paying yourself properly',
    preheader: 'After years of putting it all back in.',
    body: [
      `${c.name}, a lot of owners have spent years paying themselves last. Every spare dollar went back into the business: the van, the fit-out, the hire, the slow month.`,
      'That’s how good businesses get built. But at some point it’s fair to ask when it starts paying you back properly.',
      `A well-structured acquisition is one route. Funded with ${funding}, the bought business repays its own debt out of its own profit, and what’s left after repayments, once the deal has bedded in, is profit you didn’t have before.`,
      'Some owners put it straight back into growth, while others finally take a proper wage.',
      'Neither is the wrong answer. But it’s worth deciding which one you’re building towards.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),

  rb_switch_off: (c) => ({
    subject: 'when did you last switch off?',
    preheader: 'Properly. Phone off.',
    body: [
      `${c.name}, a personal one.`,
      'When did you last take a week off, properly, with the phone off, and come back to a business that had run fine without you?',
      'If the honest answer is “I can’t remember”, you’re in good company. Plenty of owners would say the same.',
      'It’s also the clearest sign the business depends on you, which matters for your life now and for what it’s worth if you ever sell.',
      'Reply and tell me the last time. No judgement. It helps me understand where you’re at.',
    ],
  }),

  rb_family: (c) => ({
    subject: 'the people at home',
    preheader: 'They pay part of the cost of running a business too.',
    body: [
      `${c.name}, the people who pay the cost of you running a business aren’t only you.`,
      'It’s whoever is at home when you get in late. The kids who know dinner depends on whether a job ran over. The partner who has heard “once things settle down” more than once.',
      'I’m not saying an acquisition fixes that. Done badly, it makes it worse. Done well, with the right team in the business you buy and the right structure behind it, it can be the step that gets you out of the day-to-day instead of further into it.',
      'If the people at home are part of why you’d do this, they should be part of the conversation. You’re welcome to bring them to the call.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),

  rb_staff: (c, d) => ({
    subject: 'somewhere for your best people to go',
    preheader: 'Growth isn’t just for you.',
    body: [
      `${c.name}, here’s something owners rarely mention when they talk about buying a business: what it does for their team.`,
      `In a business the size of ${yourBiz(d)}, your best people eventually hit a ceiling. There’s only one of you at the top, and only so many senior roles. Good people leave not because they’re unhappy, but because there’s nowhere left to go.`,
      'A second business changes that. One of your people becomes a site manager, another runs the integration.',
      'And the person you’ve been wanting to promote for two years finally gets the role.',
      'Who in your business would you trust to run a second one? If a name came straight to mind, reply and tell me about them.',
    ],
  }),

  // ── Identity ──
  rb_operator: (c, d) => ({
    subject: 'operator or owner?',
    preheader: 'They’re different jobs.',
    body: [
      `${c.name}, there are two jobs hiding inside the word “owner”.`,
      `One is the operator: the person who knows every customer, fixes every problem and is the reason ${yourBiz(d)} works. The other is the owner in the fuller sense: the person who decides where capital goes, which businesses to own and who runs them.`,
      d.role === 'exec'
        ? 'You told us you run the business without owning it, which means you already know the operator job inside out. Buying a business of your own is how that knowledge turns into ownership.'
        : 'Most people who build a business spend years in the first job. For many of them, buying a business is the first time they do the second one.',
      'It’s a different way of seeing yourself, and it doesn’t happen in one step. But every owner who builds a group made that shift at some point, and your first deal is where it can start.',
    ],
    cta: { label: 'Watch how it works →', href: c.link('/breakout') },
  }),

  rb_traits: (c) => ({
    subject: 'what the owners who do this share',
    preheader: 'It isn’t money.',
    body: [
      `${c.name}, I get asked a lot what the owners who end up buying a business have in common. It isn’t money, and it isn’t a finance background.`,
      'It tends to be a few plainer things:<br>• They already run something profitable and know what good looks like.<br>• They’re a little restless: the business is fine, and fine isn’t the point.<br>• They’re willing to have an awkward conversation with another owner.<br>• They make decisions on numbers, and they’ll walk away when the numbers say so.',
      'None of that is rare. What separates them is whether they decide to start.',
      'How many of the four sound like you?',
    ],
    cta: { label: 'See if you qualify →', href: c.link('/apply?again=1') },
  }),

  rb_why_josh: (c) => ({
    subject: 'why I do this',
    preheader: 'A short letter.',
    body: [
      `${c.name}, I rarely write about why I do this work, so indulge me for a minute.`,
      'Most business owners are taught one way to grow: work harder, sell more, hire slowly, repeat. It’s a good way. But it leaves out the path that changes what an owner’s life looks like fastest, which is buying another business, funded with commercial debt, seller finance and seller rollover rather than with your own savings.',
      'That path isn’t hidden because it’s risky or reckless. It’s hidden because nobody sits down with owners and explains it plainly: how a deal is structured, how to test it, when to walk away.',
      'That’s the part I like doing. Sitting with an owner who has built something real and showing them a door they didn’t know was there. Whether they walk through it is up to them.',
      'If you’ve got a question you never got to ask, reply. I read them.',
    ],
  }),

  rb_successor: (c, d) => ({
    subject: 'their side of the table',
    preheader: 'What a retiring owner actually wants.',
    body: [
      `${c.name}, put yourself in the chair of the owner across the table for a moment.`,
      `They’ve spent decades building their ${d.industry ? d.industry.one : 'business'}. They know every customer, and some of their staff have been with them for years.`,
      `Now they want out, and for many of them the biggest fear isn’t the price. It’s who takes over, and whether that person wrecks what they built.`,
      'An outsider with a bigger cheque doesn’t always ease that fear. Someone who already runs a business like theirs, who will keep the team and look after the customers, has a far better chance.',
      `That’s why many sellers are willing to carry part of the price as seller finance and roll part into a stake they keep, alongside the commercial debt. They’re backing a successor, not just selling an asset.`,
      'You could be exactly the buyer they’re hoping turns up.',
    ],
    cta: { label: 'Read why sellers roll over →', href: c.link('/guides/seller-rollover-explained') },
  }),

  rb_sellable: (c, d) => ({
    subject: 'what buyers pay more for',
    preheader: d.goal === 'exit' ? 'You said you want to sell one day.' : 'Worth knowing even if you never sell.',
    body: [
      `${c.name},`,
      d.goal === 'exit'
        ? 'You told us you want to grow and then sell. So here’s what buyers tend to pay more for, in plain terms.'
        : 'Even if you never plan to sell, it’s worth knowing what buyers tend to pay more for. It’s the same list that makes a business easier to own.',
      '• <strong>Size.</strong> Bigger businesses can command a higher multiple of profit than smaller ones.<br>• <strong>Independence.</strong> A business that runs without its owner is worth more than one that stops when they do.<br>• <strong>Spread.</strong> More customers, more sites, less dependence on any one of them.<br>• <strong>Clean numbers.</strong> Books a stranger can trust.',
      `Notice how many of those an acquisition helps with at once. It adds size, it adds spread, and it forces you to build the management layer that lets ${yourBiz(d)} run without you.`,
      'Multiples depend on the market and the business, so there are no promises here. But the direction is well understood.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),

  rb_legacy: (c, d) => ({
    subject: 'what you leave behind',
    preheader: 'A business, a group, or a job you own.',
    body: [
      `${c.name}, a bigger question than usual.`,
      `When you eventually step away from ${d.business ? d.business : yourBiz(d)}, what do you want to leave behind?`,
      'Some owners want something they can hand to their kids. Others would rather build a business their team can buy from them.',
      'For a few, the goal is to sell well and never think about it again. And then there are the ones who want a group with their name on it that outlasts them.',
      'Each of those is a different plan, and the earlier you know which one you’re building, the better your decisions get, including whether and what to buy.',
      'If you’ve got an answer, reply with it. One line is plenty.',
    ],
  }),

  rb_five_years: (c, d) => ({
    subject: 'five years down the road',
    preheader: 'Two versions of the same business.',
    body: [
      `${c.name}, a thought experiment.`,
      `Picture ${yourBiz(d)} five years from now, in two versions. In the first, it grew the way it’s growing now: a bit bigger, a bit better, and you’re still at the centre of it. In the second, you bought one business along the way, then maybe another, and your job changed from running a business to running the people who run them.`,
      d.whyNow ? `When you applied, you told us why now: ${quote(d.whyNow)}` : null,
      d.whyNow ? 'Which of the two versions answers that?' : 'Neither is wrong. But which one did you start the business hoping for?',
      'A call is a good place to work out whether the second version is realistic with your numbers.',
    ].filter(Boolean) as string[],
    cta: { label: 'Book a call →', href: book(c) },
  }),

  rb_year_honest: (c, d) => ({
    subject: 'this time next year',
    preheader: 'No rush. Just an honest look.',
    body: [
      `${c.name}, I want to be careful with this one, because “the cost of waiting” is a line people use to apply pressure. That’s not what this is.`,
      d.timeline && TIMELINES[d.timeline]
        ? `${backTimeline(d.timeline)} That’s fine. Here’s the honest trade-off.`
        : 'Here’s the honest trade-off.',
      'If you wait a year and the right business isn’t there yet, you’ve lost nothing. Waiting for the right deal is smart. But if you wait a year without looking, the right business can come and go without you knowing, because many good ones change hands quietly.',
      'So the useful move isn’t to rush. It’s to start looking, so that when you decide, you’re deciding with real options in front of you.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),

  rb_standing_still: (c, d) => ({
    subject: 'is staying the same size safer?',
    preheader: 'It feels safer. Is it?',
    body: [
      `${c.name}, a lot of owners hold back from acquisitions because staying the same size feels safer. It’s worth checking that feeling.`,
      `One business means one set of customers, one location, one key person (for many owners, that’s you). If a big customer leaves, a competitor opens next door, or you get sick, all of ${yourBiz(d)} feels it at once.`,
      'Two businesses aren’t automatically safer. A bad deal adds risk. But a sound one, tested so its profit covers its repayments around 1.5 times, can spread your risk rather than concentrate it.',
      `That’s also why the structure matters: ${funding}, so your own savings and your house aren’t what’s on the line.`,
      'Safe and small aren’t the same thing. Which one are you actually choosing?',
    ],
    cta: { label: 'Read about the 1.5 test →', href: c.link('/guides/dscr-explained') },
  }),

  // ── Personalised by industry, size and goal ──
  rb_industry: (c, d) => {
    const ind = d.industry;
    return {
      subject: ind ? `what I’d look for in ${industryName(ind)}` : 'what I’d look for in your industry',
      preheader: ind ? `If I were a ${ind.one} owner thinking about buying.` : 'If I were in your shoes, thinking about buying.',
      body: [
        `${c.name}, if I were ${ind ? `running a ${ind.one}` : 'in your shoes'} and thinking about my first acquisition, here’s roughly what I’d look for.`,
        ind
          ? `Something like ${ind.target}: close enough to share customers, staff or suppliers with you, run by an owner who’s ready to step back, with steady profit that doesn’t hang on one big client.`
          : 'Something close enough to share customers, staff or suppliers with you, run by an owner who’s ready to step back, with steady profit that doesn’t hang on one big client.',
        'I’d care less about how shiny it is and more about how much of it depends on the current owner, because that’s what you’ll need to replace.',
        `I put together a guide${ind ? ` for ${ind.owners}` : ''} on what to check and how deals like this get funded.`,
      ],
      cta: { label: ind ? `Read the ${industryName(ind)} guide →` : 'Read the guide →', href: c.link(guideFor(d)) },
    };
  },

  rb_size: (c, d) => {
    if (isLarge(d)) {
      return {
        subject: 'a platform, not a purchase',
        preheader: 'At your size, the first deal is the start of something bigger.',
        body: [
          `${c.name}, at ${sizeLine(d) ?? 'your size'}, the interesting question isn’t just “should I buy a business?”. It’s “what am I building?”.`,
          'A business your size can act as a platform: the central team, systems and lender relationships that smaller add-ons bolt onto. Each add-on is a modest deal on its own. Together, they can build a group that’s worth more than the sum of its parts.',
          `That changes how you approach the first deal. You’re not just buying profit; you’re testing the playbook: how you find targets, how you fund them with ${funding}, and how you integrate them without disrupting the core business.`,
          'If that’s the kind of conversation you want to have, it’s worth a proper call.',
        ],
        cta: { label: 'Book a call →', href: book(c) },
      };
    }
    return {
      subject: d.revenue === '1_3m' ? 'your first tuck-in' : 'the right-sized first deal',
      preheader: 'Small, close to home and sound.',
      body: [
        `${c.name}, ${sizeLine(d) ? `for ${sizeLine(d)}` : 'for most owners'}, the right first deal is a tuck-in: a smaller business that slots into what you already run.`,
        'Same kind of work, same area, overlapping customers. You keep one office, one admin team and one set of systems, and much of the smaller business’s profit drops straight through.',
        'It’s also the gentlest way to learn. The stakes are smaller, the integration is simpler, and you come out of it knowing how to do the next one.',
        'Do you already have a business in mind that would tuck in? Reply with what kind it is. No names needed.',
      ],
      cta: { label: 'Read about buying a competitor →', href: c.link('/guides/buy-your-competitor') },
    };
  },

  rb_goal: (c, d) => {
    const g = d.goal && GOALS[d.goal] ? d.goal : null;
    const subject = ({ acquire: 'one competitor at a time', group: 'the first brick in a group', exit: 'selling something bigger', unsure: 'if you’re still deciding' } as Record<string, string>)[g ?? ''] ?? 'which owner do you want to be?';
    const middle: Record<string, string[]> = {
      acquire: [
        `You told us you want to ${GOALS.acquire.line}. That says something about how you see yourself: not as someone protecting what they’ve got, but as someone who expects to be the one buying, not the one being bought.`,
        'That mindset is most of it. The rest is a target list, a sound structure and the patience to wait for the right one.',
      ],
      group: [
        `You told us you want to ${GOALS.group.line}. That’s a different identity from running a business: you become the person who chooses which businesses to own and who runs them.`,
        'Groups are built one sensible deal at a time. The first one doesn’t need to be big. It needs to be repeatable.',
      ],
      exit: [
        `You told us you want to ${GOALS.exit.line}. That means you’re already thinking like a seller, which is exactly the right lens for buying.`,
        'Every decision between now and your exit is really a question about what a future buyer will pay for. A sound acquisition can answer several of those questions at once.',
      ],
      unsure: [
        'You told us you weren’t sure yet what you wanted. That’s honest, and more common than people admit.',
        'Sometimes the clearest way to decide is to see the options laid out with real numbers: grow organically, buy a competitor, build a group, or set up for a sale. Seeing them side by side tends to make the answer obvious.',
      ],
    };
    return {
      subject,
      preheader: g ? 'What you told us you wanted.' : 'Growing, building or selling.',
      body: [
        `${c.name},`,
        ...(g ? middle[g] : [
          'Owners who think about acquisitions fall into three broad camps: those who want to grow by buying competitors, those who want to build a group, and those who want to grow and then sell for more.',
          'Each one leads to a different first deal. Knowing which camp you’re in is the first decision, and it’s yours to make.',
        ]),
        'If it’s still what you want, let’s look at what it means for your numbers.',
      ],
      cta: { label: 'See if you qualify →', href: c.link('/apply?again=1') },
    };
  },

  rb_masterclass: (c, d) => ({
    subject: 'an hour on the bigger picture',
    preheader: 'If a call feels like too big a step.',
    body: [
      `${c.name}, if you’ve been reading these and thinking “interesting, but I’m not ready to talk to anyone”, that’s fair.`,
      `There’s a middle step. The masterclass is about an hour on the whole picture: where the off-market businesses worth buying are${d.industry ? ` in markets like ${industryName(d.industry)}` : ''}, how deals get funded with commercial debt, seller finance and seller rollover, and the 90-day path to a signed letter of intent.`,
      'Watch it, then decide whether a call makes sense. No pressure either way.',
    ],
    cta: { label: 'Pick a session →', href: c.link('/webinar') },
  }),

  rb_permission: (c, d) => ({
    subject: 'who gets to be a buyer',
    preheader: 'It isn’t only funds and big companies.',
    body: [
      `${c.name}, there’s a quiet assumption a lot of owners carry: buying businesses is something other people do: private equity, big groups, people with a finance background and a lot of cash.`,
      `It isn’t the whole picture. Plenty of ${d.industry ? d.industry.many : 'owner-run businesses'} that change hands are bought by someone who knows the work: a competitor, a neighbour in the same trade, a manager, an owner like you.`,
      `What makes someone a credible buyer to a seller and a lender isn’t a title. It’s a profitable business they already run${sizeLine(d) ? ` (you told us yours is ${sizeLine(d)})` : ''}, an understanding of the industry, and a deal that pays for itself.`,
      'You don’t need anyone’s permission to think of yourself as a buyer. You just need a sound first deal.',
    ],
    cta: { label: 'See if you qualify →', href: c.link('/apply?again=1') },
  }),

  rb_stand: (c, d) => {
    const b = blockerOf(d);
    return {
      subject: 'where are you standing?',
      preheader: 'Three honest options.',
      body: [
        `${c.name}, I’ve sent a fair few thoughts your way over the last few days, about the opportunity, your time, and what kind of owner you want to be.`,
        b && b !== BLOCKERS.never_considered
          ? `I know ${b.name} was one of the things in the way when you came to us. Whether that’s changed or not, I’d like to know where you are.`
          : 'I’d like to know where all of that has landed for you.',
        'If you had to pick one:<br>1. Still building what I’ve got. Acquisitions are for later.<br>2. Interested, and I’d like to see what a deal could look like for me.<br>3. Not for me.',
        'Just reply with the number. Any of the three is a useful answer.',
      ],
    };
  },
};

/** "You said you wanted to move within six months." — from their timeline answer. */
function backTimeline(t: string) {
  return ({
    '0_6': 'You told us you wanted to move within six months.',
    '6_12': 'You told us six to twelve months.',
    '12_plus': 'You told us twelve months or more.',
    exploring: 'You told us you were just exploring.',
  } as Record<string, string>)[t] ?? '';
}

export const REACTIVATE_B_ORDER: string[] = [
  // day 14
  'rb_succession', 'rb_in_vs_on', 'rb_second_profit',
  // day 15
  'rb_organic', 'rb_double', 'rb_industry',
  // day 16
  'rb_first_mover', 'rb_successor', 'rb_gm',
  // day 17
  'rb_local', 'rb_size', 'rb_switch_off',
  // day 18
  'rb_boring', 'rb_time_back', 'rb_staff',
  // day 19
  'rb_operator', 'rb_goal', 'rb_take_home',
  // day 20
  'rb_why_josh', 'rb_sellable', 'rb_legacy',
  // day 21
  'rb_traits', 'rb_deal_two', 'rb_family',
  // day 22
  'rb_standing_still', 'rb_five_years', 'rb_masterclass',
  // day 23
  'rb_year_honest', 'rb_permission', 'rb_stand',
];
