// The prospecting bots' emails: short and direct. One email a day for 30 or 60 days, every email ends on the
// point, no softeners. Shared by the server (what gets sent) and the editor (the live preview), so what you see is
// what goes out. A signature and an opt-out line are added on send.
export const MAX_TOUCHES = 60;
export const FLOW_LENGTHS = [10, 30, 60];

// ------------------------------------------------------------------ buying: email owners of businesses you'd buy
const BUY_30 = [
  "Hi {first},\n\nMy name is {sender}, I run {group}. We buy {buying} in {area}.\n\nWould you consider selling {company}?\n\n{sender}",
  "Hi {first},\n\nFollowing up on my email {when}. We're buying {buying} in {area} this year and {company} is on our list.{signal}\n\nAre you open to a conversation?\n\n{sender}",
  "Hi {first},\n\nWe're not brokers. We buy businesses and run them.\n\nIf you'd sell {company} for the right price, reply and I'll call you.\n\n{sender}",
  "Hi {first},\n\nYour team keeps their jobs when we buy. That's how we do every deal.\n\nWant to talk about {company}?\n\n{sender}",
  "Hi {first},\n\nOne question: if someone offered a fair price for {company} this year, would you take the call?\n\n{sender}",
  "Hi {first},\n\nMost owners we buy from stay on for a handover period and then step back. You choose how long.\n\nCan we talk this week?\n\n{sender}",
  "Hi {first},\n\nI've emailed a few times about buying {company}. A call is quicker: {phone}.\n\n{sender}\n{group}",
  "Hi {first},\n\nWe can structure a deal so you keep getting paid after the sale, not just once at settlement.\n\nWorth 15 minutes?\n\n{sender}",
  "Hi {first},\n\nWe've looked at {company} and we're serious.\n\nReply with a time that suits and I'll call.\n\n{sender}",
  "Hi {first},\n\nIf you're not selling now, tell me when. I'll come back then.\n\n{sender}",
  "Hi {first},\n\nWe buy {buying} because we know the work and the people. {company} fits.\n\nAre you open to an offer?\n\n{sender}",
  "Hi {first},\n\nNo brokers, no listing, no fees on your side. A direct sale to us.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nI'll tell you what {company} is worth to a buyer like us, free, whether you sell or not.\n\nWant the number?\n\n{sender}",
  "Hi {first},\n\nCalling is easier than email. My direct line is {phone}.\n\n{sender}\n{group}",
  "Hi {first},\n\nWe close in weeks, not months, and we keep your name on the door if you want.\n\nShall we talk?\n\n{sender}",
  "Hi {first},\n\nStill keen on {company}. Still buying in {area}.\n\nReply yes and I'll send a few times for a call.\n\n{sender}",
  "Hi {first},\n\nOwners who sell to us get a clean exit, a fair price and a team that's looked after.\n\nIs that something you'd want?\n\n{sender}",
  "Hi {first},\n\nA short call, no obligation. You'll know exactly where you stand.\n\n{call}\n\n{sender}",
  "Hi {first},\n\nIf the timing's wrong, reply \"later\" and I'll stop until you're ready.\n\n{sender}",
  "Hi {first},\n\nWe're adding businesses in {area} this quarter. {company} is first on my list.\n\nCan we talk?\n\n{sender}",
  "Hi {first},\n\nWe've bought businesses like {company} before. The owners would take our call again.\n\nWill you take ours?\n\n{sender}",
  "Hi {first},\n\nI've been trying to reach you for a few weeks. Call me on {phone}.\n\n{sender}\n{group}",
  "Hi {first},\n\nSelling a business is easier than most owners think. We handle the hard parts.\n\nWant to see how it works?\n\n{sender}",
  "Hi {first},\n\nNot every buyer will keep your staff and your standards. We will.\n\nOpen to a chat about {company}?\n\n{sender}",
  "Hi {first},\n\nWe'd like to make you an offer for {company}.\n\nWhat's the best number to reach you?\n\n{sender}",
  "Hi {first},\n\nIf you've ever thought about your exit, now is a good time to talk. Buyers are paying well.\n\nShall I call?\n\n{sender}",
  "Hi {first},\n\nQuick one: who should I speak to about {company}'s future, you or someone else?\n\n{sender}",
  "Hi {first},\n\nI'll keep this short. We want to buy {company}. Reply and we'll talk.\n\n{sender}",
  "Hi {first},\n\nTwo emails left from me this month. My number is {phone} if a call suits better.\n\n{sender}\n{group}",
  "Hi {first},\n\nLast email for now. If you ever want to sell {company}, my direct line is {phone}.\n\n{sender}\n{group}",
];
const BUY_60_EXTRA = [
  "Hi {first},\n\nIt's {sender} from {group} again. We're still buying {buying} in {area}.\n\nIs selling {company} on your mind this year?\n\n{sender}",
  "Hi {first},\n\nA lot has changed since I first wrote. Our interest in {company} hasn't.\n\nCan we talk?\n\n{sender}",
  "Hi {first},\n\nOwners often wait too long to sell and take less. Talking early costs nothing.\n\nShall I call?\n\n{sender}",
  "Hi {first},\n\nWe pay fairly and we pay on time. References from owners we've bought from are yours on request.\n\nWant them?\n\n{sender}",
  "Hi {first},\n\nIf you'd rather sell part of {company} and keep a stake, we do that too.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nMy direct line is {phone}. Five minutes is enough to know if it makes sense.\n\n{sender}",
  "Hi {first},\n\nWe've just added another business in {area}. There's room for {company}.\n\nOpen to talking?\n\n{sender}",
  "Hi {first},\n\nNo pressure and no deadline. When you want to talk about selling, I'm here.\n\nShould I check back in a month?\n\n{sender}",
  "Hi {first},\n\nYour customers stay looked after. Your team stays employed. You get paid.\n\nWant to talk about {company}?\n\n{sender}",
  "Hi {first},\n\nReply with one word: now, later or never. I'll act on it.\n\n{sender}",
  "Hi {first},\n\nWe know {buying} in {area} well. We'd run {company} the way you built it.\n\nCan we meet?\n\n{sender}",
  "Hi {first},\n\nI'd like to buy you a coffee and talk about {company}. Any day this week.\n\nWhen suits?\n\n{sender}",
  "Hi {first},\n\nStill here, still interested. Call me on {phone}.\n\n{sender}\n{group}",
  "Hi {first},\n\nWe buy the business, not just the building or the client list. Everything stays together.\n\nWant to talk about {company}?\n\n{sender}",
  "Hi {first},\n\nThe sooner we talk, the more options you have on price and timing.\n\nCan I call you this week?\n\n{sender}",
  "Hi {first},\n\nIf a family member or partner is part of the decision, I'm happy to meet them too.\n\nShall we set a time?\n\n{sender}",
  "Hi {first},\n\nA valuation from us is free and confidential. You decide what to do with it.\n\nWant one for {company}?\n\n{sender}",
  "Hi {first},\n\nWe've got the funding lined up. The only question is whether you want to sell.\n\nDo you?\n\n{sender}",
  "Hi {first},\n\nSome owners want out in six months, some in three years. Both work for us.\n\nWhat's your timeline?\n\n{sender}",
  "Hi {first},\n\nI haven't heard back, so I'll keep it simple: we want {company}. Reply when ready.\n\n{sender}",
  "Hi {first},\n\nSelling to a local buyer keeps {company} in good hands. That's us.\n\nCan we talk?\n\n{sender}",
  "Hi {first},\n\nMy number again: {phone}. Call any weekday.\n\n{sender}\n{group}",
  "Hi {first},\n\nWe'll do the paperwork, the lawyers and the handover plan. You run the business until settlement.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nIf someone else has already approached you, talk to us too. Competition gets you a better price.\n\nShall I call?\n\n{sender}",
  "Hi {first},\n\nWe're making offers in {area} before the end of the quarter.\n\nWant one for {company}?\n\n{sender}",
  "Hi {first},\n\nIt's been two months of emails. I'm still serious about {company}.\n\nCan we speak this week?\n\n{sender}",
  "Hi {first},\n\nWhat would it take for you to sell {company}? Tell me the number.\n\n{sender}",
  "Hi {first},\n\nA few emails left from me. After that, the door stays open: {phone}.\n\n{sender}",
  "Hi {first},\n\nIf you know another owner in {area} thinking of selling, I'd value the introduction.\n\n{sender}",
  "Hi {first},\n\nOne last push: we want to buy {company}. Reply yes and I'll call today.\n\n{sender}",
  "Hi {first},\n\nI'll stop here so I'm not filling your inbox.\n\n{sender}",
  "Hi {first},\n\nFinal email. When you're ready to sell {company}, call me on {phone}.\n\n{sender}\n{group}",
];

// ------------------------------------------------------------------ selling: shop a business to buyers (PE funds)
const SELL_30 = [
  "Hi {first},\n\nI'm {sender}. I'm selling {business}: {revenue} revenue, {ebitda} EBITDA.\n\nDo you want the teaser?\n\n{sender}",
  "Hi {first},\n\nFollowing up on {business}. It fits {fund}'s criteria on size and sector.\n\nShall I send the teaser?\n\n{sender}",
  "Hi {first},\n\nWe're running a short process with a handful of buyers. {fund} is on the list.\n\nAre you interested in {business}?\n\n{sender}",
  "Hi {first},\n\nThe management team stays after the sale. Growth plan and numbers are in the teaser.\n\nWant it?\n\n{sender}",
  "Hi {first},\n\nIt makes {ebitda} EBITDA from recurring customers, and no single customer is over a fifth of revenue.\n\nShall I send the details under NDA?\n\n{sender}",
  "Hi {first},\n\nIt's also a strong platform for add-ons in {sector}. There are several targets nearby.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nA call might be quicker: {phone}.\n\n{sender}",
  "Hi {first},\n\nWe've had early interest from other buyers. I'd rather include {fund} than not.\n\nShould I send the teaser today?\n\n{sender}",
  "Hi {first},\n\nWho at {fund} looks at {sector} deals of this size? I'll send it to them directly.\n\n{sender}",
  "Hi {first},\n\nIf {business} isn't a fit, reply \"pass\" and I'll take you off the list.\n\n{sender}",
  "Hi {first},\n\nThe numbers are clean, reviewed and ready for diligence.\n\nDo you want the information memorandum?\n\n{sender}",
  "Hi {first},\n\n{Business} has grown every year for the last three years. The teaser shows the detail.\n\nShall I send it?\n\n{sender}",
  "Hi {first},\n\nWe're setting dates for management meetings. Want a slot?\n\n{sender}",
  "Hi {first},\n\nMy direct line is {phone}. Happy to walk you through {business} in 15 minutes.\n\n{sender}",
  "Hi {first},\n\nThe owner is open to rolling equity for the right partner.\n\nDoes that change {fund}'s interest?\n\n{sender}",
  "Hi {first},\n\nStill keen to include {fund}. Reply \"send\" and the teaser is in your inbox today.\n\n{sender}",
  "Hi {first},\n\nIndicative offers are coming in. If you want a look at {business}, now is the time.\n\n{sender}",
  "Hi {first},\n\nWhat would {fund} need to see to put an indicative offer on {business}?\n\n{sender}",
  "Hi {first},\n\nIf the timing's wrong for your fund, tell me when to come back.\n\n{sender}",
  "Hi {first},\n\n{Business}. {revenue} revenue. {ebitda} EBITDA. Selling this quarter.\n\nWant in?\n\n{sender}",
  "Hi {first},\n\nWe can share the data room the day you sign the NDA.\n\nShall I send the NDA?\n\n{sender}",
  "Hi {first},\n\nI've written a few times about {business}. A call is easier: {phone}.\n\n{sender}",
  "Hi {first},\n\nThe business runs without the owner day to day. The team is in place.\n\nInterested in the detail?\n\n{sender}",
  "Hi {first},\n\nThere's a clear path to double EBITDA through add-ons and pricing. It's in the teaser.\n\nWant it?\n\n{sender}",
  "Hi {first},\n\nWe'd like a decision from each buyer soon. Is {fund} in or out?\n\n{sender}",
  "Hi {first},\n\nIf there's a better person at {fund} for this, point me to them.\n\n{sender}",
  "Hi {first},\n\nLast call for first-round interest on {business}. Reply and I'll send everything.\n\n{sender}",
  "Hi {first},\n\nI'll keep it short. {business} is for sale. Want the teaser?\n\n{sender}",
  "Hi {first},\n\nTwo emails left from me. My number is {phone}.\n\n{sender}",
  "Hi {first},\n\nLast email on {business} for now. If {fund} wants a look later, call me on {phone}.\n\n{sender}",
];
const SELL_60_EXTRA = [
  "Hi {first},\n\nUpdate on {business}: the year closed strong. Updated numbers are ready.\n\nWant them?\n\n{sender}",
  "Hi {first},\n\nWe're now in a second round with a few buyers. There's still room for {fund}.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nIs {sector} still a focus for {fund}? If so, {business} should be on your desk.\n\n{sender}",
  "Hi {first},\n\nThe owner wants a partner, not just a cheque. {fund}'s approach fits.\n\nShall we talk?\n\n{sender}",
  "Hi {first},\n\n{Business}: {ebitda} EBITDA. Still available.\n\nWant the teaser?\n\n{sender}",
  "Hi {first},\n\nCall me on {phone} and I'll give you the story in 10 minutes.\n\n{sender}",
  "Hi {first},\n\nWe can move quickly for the right buyer. Exclusivity is on the table.\n\nIs {fund} interested?\n\n{sender}",
  "Hi {first},\n\nThe quality of earnings work is done. Diligence will be fast.\n\nShall I send the pack?\n\n{sender}",
  "Hi {first},\n\nIf {fund} has a portfolio company in {sector}, {business} could be a strong add-on.\n\nWorth a look?\n\n{sender}",
  "Hi {first},\n\nReply with one word: interested, pass or later.\n\n{sender}",
  "Hi {first},\n\nCustomer retention is high and contracts renew year after year. Detail in the memorandum.\n\nWant it?\n\n{sender}",
  "Hi {first},\n\nA short call this week? {call}\n\n{sender}",
  "Hi {first},\n\nWe've had questions from other buyers about growth. The answers are in a one-page summary.\n\nShall I send it?\n\n{sender}",
  "Hi {first},\n\nThe owner will stay on for a transition. Key staff are committed.\n\nInterested in {business}?\n\n{sender}",
  "Hi {first},\n\nWhat size and sector is {fund} looking at right now? I'll tell you straight if {business} fits.\n\n{sender}",
  "Hi {first},\n\nStill selling {business}. Still keen to include {fund}.\n\n{sender}",
  "Hi {first},\n\nThere are a few clear add-on targets within driving distance. The plan is ready.\n\nWant it?\n\n{sender}",
  "Hi {first},\n\nMy number again: {phone}.\n\n{sender}",
  "Hi {first},\n\nBuyers are active in {sector} right now. {Business} will draw several offers.\n\nDoes {fund} want to be one of them?\n\n{sender}",
  "Hi {first},\n\nWe can share a redacted customer list and the monthly numbers after the NDA.\n\nShall I send the NDA?\n\n{sender}",
  "Hi {first},\n\nWe expect to choose a preferred buyer soon. Do you want to be in the running?\n\n{sender}",
  "Hi {first},\n\nIf {fund}'s criteria have changed, tell me and I'll stop.\n\n{sender}",
  "Hi {first},\n\nThe teaser is two pages. It takes five minutes to read.\n\nShall I send it?\n\n{sender}",
  "Hi {first},\n\n{Business} has room to grow with more capital. That's what we want from a partner.\n\nIs that {fund}?\n\n{sender}",
  "Hi {first},\n\nWe're open to a majority sale or a minority recap.\n\nWhich would {fund} consider?\n\n{sender}",
  "Hi {first},\n\nTwo months in, the interest is strong. A final look for {fund}?\n\n{sender}",
  "Hi {first},\n\nWhat would make {business} a yes for {fund}?\n\n{sender}",
  "Hi {first},\n\nA few emails left from me. After that, call {phone} any time.\n\n{sender}",
  "Hi {first},\n\nIf you know another fund that should see {business}, I'd value the introduction.\n\n{sender}",
  "Hi {first},\n\nLast chance to see {business} before we pick a buyer.\n\nWant the teaser?\n\n{sender}",
  "Hi {first},\n\nI'll stop here so I'm not filling your inbox.\n\n{sender}",
  "Hi {first},\n\nFinal email. If {fund} wants to look at {business} later, my number is {phone}.\n\n{sender}",
];

// ------------------------------------------------------------------ selling: strategic buyers (bigger operators in the same field)
const STRAT_30 = [
  "Hi {first},\n\nI'm {sender}. I'm selling {business}: {revenue} revenue, {ebitda} EBITDA. It would add {area} to {buyer}'s footprint.\n\nWant to talk?\n\n{sender}",
  "Hi {first},\n\nFollowing up on {business}. Same customers, same work as {buyer}, in {area}.\n\nAre you interested?\n\n{sender}",
  "Hi {first},\n\nBuying {business} gets {buyer} a trained team, a customer base and a location in {area} in one step.\n\nShall I send the details?\n\n{sender}",
  "Hi {first},\n\nI'm talking to a small number of buyers. {buyer} is one I'd like at the table.\n\nOpen to a call?\n\n{sender}",
  "Hi {first},\n\nThe staff stay and the customers stay. You get the growth without the start-up cost.\n\nInterested in {business}?\n\n{sender}",
  "Hi {first},\n\nWho at {buyer} looks at acquisitions? I'll send it to them directly.\n\n{sender}",
  "Hi {first},\n\nA call is quicker: {phone}.\n\n{sender}",
  "Hi {first},\n\n{Business} has grown every year. The numbers are ready to share under NDA.\n\nWant them?\n\n{sender}",
  "Hi {first},\n\nIf {buyer} is expanding in {area}, this is the fastest way to do it.\n\nShall we talk?\n\n{sender}",
  "Hi {first},\n\nIf it's not a fit, reply \"pass\" and I'll take {buyer} off the list.\n\n{sender}",
  "Hi {first},\n\nThe owner will stay for a handover so nothing is lost in the transition.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nCombining {business} with {buyer} cuts costs on admin, purchasing and marketing straight away.\n\nWorth a conversation?\n\n{sender}",
  "Hi {first},\n\nWe're setting up meetings with interested buyers. Want a time?\n\n{sender}",
  "Hi {first},\n\nMy direct line is {phone}. Ten minutes is enough to see if it fits.\n\n{sender}",
  "Hi {first},\n\nI'd rather sell to an operator who knows this work than to a fund. That's why I'm writing to {buyer}.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nStill keen to include {buyer}. Reply \"send\" and the summary is in your inbox today.\n\n{sender}",
  "Hi {first},\n\nOther buyers are looking. If {buyer} wants a look, now is the time.\n\n{sender}",
  "Hi {first},\n\nWhat would {buyer} need to see to make an offer on {business}?\n\n{sender}",
  "Hi {first},\n\nIf the timing's wrong, tell me when to come back.\n\n{sender}",
  "Hi {first},\n\n{Business}. {revenue} revenue. {ebitda} EBITDA. In {area}. For sale this quarter.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nI can share the customer mix, staff list and monthly numbers after an NDA.\n\nShall I send the NDA?\n\n{sender}",
  "Hi {first},\n\nI've written a few times. A call is easier: {phone}.\n\n{sender}",
  "Hi {first},\n\nThe business runs day to day without the owner. The team is in place.\n\nInterested in the detail?\n\n{sender}",
  "Hi {first},\n\nA competitor buying {business} would take this patch from {buyer}. Better that {buyer} owns it.\n\nShall we talk?\n\n{sender}",
  "Hi {first},\n\nI'd like an answer from each buyer soon. Is {buyer} in or out?\n\n{sender}",
  "Hi {first},\n\nIf someone else at {buyer} handles this, point me to them.\n\n{sender}",
  "Hi {first},\n\nLast call for first offers on {business}. Reply and I'll send everything.\n\n{sender}",
  "Hi {first},\n\nShort version: {business} is for sale and it fits {buyer}. Want the details?\n\n{sender}",
  "Hi {first},\n\nTwo emails left from me. My number is {phone}.\n\n{sender}",
  "Hi {first},\n\nLast email on {business} for now. If {buyer} wants a look later, call me on {phone}.\n\n{sender}",
];
const STRAT_60_EXTRA = [
  "Hi {first},\n\nUpdate on {business}: still for sale, and the year closed strong.\n\nWant the numbers?\n\n{sender}",
  "Hi {first},\n\nWe're in talks with a few buyers. There's still room for {buyer}.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nIs {buyer} still growing in {area}? If so, {business} should be on your desk.\n\n{sender}",
  "Hi {first},\n\nThe owner wants the team looked after. An operator like {buyer} does that better than anyone.\n\nShall we talk?\n\n{sender}",
  "Hi {first},\n\n{Business}: {ebitda} EBITDA. Still available.\n\nWant the summary?\n\n{sender}",
  "Hi {first},\n\nCall me on {phone} and I'll walk you through it in 10 minutes.\n\n{sender}",
  "Hi {first},\n\nWe can move fast for the right buyer. Exclusivity is on the table.\n\nIs {buyer} interested?\n\n{sender}",
  "Hi {first},\n\nThe books are clean and ready for review.\n\nShall I send the pack?\n\n{sender}",
  "Hi {first},\n\nBuying is cheaper than opening a new site from scratch, and the customers come with it.\n\nWorth a look?\n\n{sender}",
  "Hi {first},\n\nReply with one word: interested, pass or later.\n\n{sender}",
  "Hi {first},\n\nCustomers stay year after year. The detail is in the summary.\n\nWant it?\n\n{sender}",
  "Hi {first},\n\nA short call this week? {call}\n\n{sender}",
  "Hi {first},\n\nThe staff are experienced and committed to staying. That's rare in this field.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nIf {buyer} wants to buy rather than build in {area}, this is it.\n\nShall we talk?\n\n{sender}",
  "Hi {first},\n\nWhat size of acquisition is {buyer} looking at? I'll tell you straight if this fits.\n\n{sender}",
  "Hi {first},\n\nStill selling {business}. Still keen to include {buyer}.\n\n{sender}",
  "Hi {first},\n\nI'm happy to meet at your office or ours. Which suits?\n\n{sender}",
  "Hi {first},\n\nMy number again: {phone}.\n\n{sender}",
  "Hi {first},\n\nWe expect to pick a buyer soon. Do you want to be in the running?\n\n{sender}",
  "Hi {first},\n\nIf {buyer} isn't buying this year, tell me and I'll stop.\n\n{sender}",
  "Hi {first},\n\nThe summary is two pages. It takes five minutes to read.\n\nShall I send it?\n\n{sender}",
  "Hi {first},\n\nThe owner is open to staying on part time if that helps {buyer}.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nWe're open to a full sale or a staged sale over a couple of years.\n\nWhich would {buyer} consider?\n\n{sender}",
  "Hi {first},\n\nTwo months in, interest is strong. A last look for {buyer}?\n\n{sender}",
  "Hi {first},\n\nWhat would make {business} a yes for {buyer}?\n\n{sender}",
  "Hi {first},\n\nA few emails left from me. After that, call {phone} any time.\n\n{sender}",
  "Hi {first},\n\nIf you know another operator who should see {business}, I'd value the introduction.\n\n{sender}",
  "Hi {first},\n\nLast chance to see {business} before we pick a buyer.\n\nWant the details?\n\n{sender}",
  "Hi {first},\n\nI'll stop here so I'm not filling your inbox.\n\n{sender}",
  "Hi {first},\n\nFinal email. If {buyer} wants to look at {business} later, my number is {phone}.\n\n{sender}",
  "Hi {first},\n\nThe location, the lease and the equipment all come with it.\n\nInterested?\n\n{sender}",
  "Hi {first},\n\nOperators who bought businesses like this one doubled their reach in a year.\n\nShall we talk?\n\n{sender}",
];

export const FLOWS = {
  buy: { subject: "Buying {buying} in {area}", 30: BUY_30, 60: [...BUY_30.slice(0, 28), ...BUY_60_EXTRA] },
  sell: { subject: "For sale: {business}", 30: SELL_30, 60: [...SELL_30.slice(0, 28), ...SELL_60_EXTRA] },
  strategic: { subject: "{Business}: a fit for {buyer}", 30: STRAT_30, 60: [...STRAT_30.slice(0, 28), ...STRAT_60_EXTRA.slice(0, 32)] },
};
// A short flow keeps the opener, the strongest follow-ups and the final email.
const shortFlow = (all) => [all[0], all[1], all[2], all[4], all[6], all[8], all[12], all[16], all[21], all[29]];
export function defaultTemplates(kind = "buy", days = 30) {
  const f = FLOWS[FLOWS[kind] ? kind : "buy"];
  return { subject: f.subject, steps: days >= 60 ? f[60] : days <= 10 ? shortFlow(f[30]) : f[30] };
}
export const DEFAULT_TEMPLATES = defaultTemplates("buy", 30);

// How each kind of business reads in "we buy …".
const BUYING = { hvac: "HVAC businesses", plumbing: "plumbing businesses", electrical: "electrical contractors", roofing: "roofing businesses", landscaping: "landscaping businesses",
  cleaning: "cleaning businesses", pest: "pest control businesses", dental: "dental practices", gp: "medical practices", physio: "physio clinics", vet: "vet clinics",
  accounting: "accounting firms", insurance: "insurance brokerages", it: "IT businesses", auto: "auto repair shops", trucking: "trucking companies", waste: "waste businesses",
  security: "security businesses", engineering: "engineering firms", funeral: "funeral homes", childcare: "childcare centres" };
export const buyingFor = (industryId, fallback = "") => BUYING[industryId] || pluralize(fallback) || "businesses like yours";

const pluralWord = (w) => (/(s|x|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
export const pluralize = (phrase) => String(phrase || "").trim().replace(/(\w+)$/, (w) => pluralWord(w));

// One plain sentence from what we know about the business (or nothing).
export function signalLine(s = {}) {
  if (s.reviews >= 20 && s.rating) return ` Your ${s.reviews} reviews at ${s.rating} stars stood out.`;
  if (s.years >= 10) return ` ${s.years} years of trading stood out.`;
  return "";
}

// Which template an email uses: the first is the opener, the last is always the final email, and when there are
// more emails than templates the middle ones repeat.
export function templateIndex(step, touches, n) {
  if (step <= 1 || n === 1) return 0;
  if (step >= touches) return n - 1;
  if (step <= n - 2) return step - 1;
  return n <= 2 ? n - 1 : 1 + ((step - 2) % (n - 2));
}

const money = (v, cur = "$") => (!(+v > 0) ? "" : +v >= 1e6 ? `${cur}${(+v / 1e6).toFixed(1).replace(/\.0$/, "")}M` : `${cur}${Math.round(+v / 1e3)}k`);

// step: 1-based. vars (buy): first, company, sender, group, buying, area, phone, signals, touches, gapDays, kind
//                vars (sell): first, fund, sender, business, sector, area, revenue, ebitda, currency, phone, touches
export function renderEmail(templates, step, vars) {
  const kind = FLOWS[vars.kind] ? vars.kind : "buy";
  const base = defaultTemplates(kind, vars.touches || 30);
  const t = { ...base, ...(templates || {}) };
  const steps = Array.isArray(t.steps) && t.steps.length ? t.steps : base.steps;
  let body = steps[templateIndex(step, vars.touches || steps.length, steps.length)];
  // No figures given: drop them from the sentence instead of writing "solid EBITDA".
  if (!(+vars.revenue > 0)) body = body.replace(/\. \{revenue\} revenue(?=\.)/, "");
  if (!(+vars.ebitda > 0)) body = body.replace(/\. \{ebitda\} EBITDA(?=\.)/, "");
  if (!(+vars.revenue > 0)) body = body.replace(/:? \{revenue\} revenue,? ?/, (m) => (m.startsWith(":") ? ": " : "")).replace(/\{revenue\} revenue\. /, "");
  if (!(+vars.ebitda > 0)) body = body.replace(/: \{ebitda\} EBITDA\./, ".").replace(/ \{ebitda\} EBITDA\./, ".").replace(/: $/m, ".").replace(/It makes \{ebitda\} EBITDA from recurring customers, and/, "Customers are recurring, and").replace(/\{Business\}: \{ebitda\} EBITDA\./, "{Business} is").replace(/\{ebitda\} EBITDA\. /, "");
  const phone = String(vars.phone || "").trim();
  const v = {
    first: String(vars.first || "").trim() || "there", company: vars.company || "your business", sender: vars.sender || "", group: vars.group || "",
    buying: vars.buying || "businesses like yours", area: vars.area || "your area", phone: phone || "reply to this email",
    call: phone ? `Call or text me on ${phone}.` : "Reply to this email and I'll call you.", signal: signalLine(vars.signals || {}),
    when: (vars.gapDays || 1) <= 1 ? "yesterday" : "the other day",
    fund: vars.fund || "your fund", buyer: vars.buyer || vars.fund || "your business", business: vars.business || "my business", sector: vars.sector || "this sector",
    Business: (vars.business || "my business").replace(/^./, (c) => c.toUpperCase()),
    revenue: money(vars.revenue, vars.currency || "$") || "strong", ebitda: money(vars.ebitda, vars.currency || "$") || "solid",
  };
  const fill = (s) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
  let text = fill(body).replace(/\n{3,}/g, "\n\n").trim();
  if (!v.group) text = text.replace(/, I run \./, ".").replace(/ from \.(?=\s)/, ".").replace(/\n\s*$/gm, "\n").trim();
  const first = fill(t.subject || base.subject).trim().slice(0, 140);
  return { subject: step === 1 ? first : `Re: ${first}`, body: text };
}

export function cleanTemplates(t, nested = true) {
  const out = {};
  if (nested && t && t.strategic && typeof t.strategic === "object") { const st = cleanTemplates(t.strategic, false); if (Object.keys(st).length) out.strategic = st; }
  if (t && typeof t.subject === "string" && t.subject.trim()) out.subject = t.subject.trim().slice(0, 140);
  if (t && Array.isArray(t.steps)) {
    const steps = t.steps.map((s) => String(s || "").trim().slice(0, 2000)).filter(Boolean).slice(0, MAX_TOUCHES);
    if (steps.length) out.steps = steps;
  }
  return out;
}
