import type { Guide } from '../types';

/**
 * Data guides (host: 'data'). Internal links go only to the other data guides and to / (the data page).
 */
export const DATA_GUIDES: Guide[] = [
  {
    slug: 'sell-your-business-data-to-ai-companies',
    title: 'Sell Your Business Data to AI Companies: How It Works',
    description:
      'How established business owners sell anonymised operational data to AI companies: what buyers want, what it pays, what stays private and how a deal runs.',
    h1: 'How to Sell Your Business Data to AI Companies',
    answer:
      'Selling your business data to AI companies means licensing or selling anonymised operational records, such as workflows, job history, scheduling and maintenance logs, to buyers who use them to train and test AI systems. It is not customer personal data. You give up no equity, take on no loan and keep control of your business. Deals typically land between $200,000 and $2 million.',
    keyPoints: [
      'AI data buyers want operational data: how real work gets scheduled, done, fixed and recorded.',
      'Customer names, contact details and card data are not what is being bought, and should not be sold.',
      'Our partner has around $1 billion committed to buying this data; deals typically land between $200,000 and $2 million.',
      'No equity, no loan and no change of control. Closed or sold businesses can qualify if the owner still holds the records.',
      'Check your privacy obligations and contracts before selling anything.',
    ],
    body: `## What does "selling business data to AI companies" actually mean?

AI companies have trained their models on the public internet: websites, books and forums. What they largely lack is a record of how real businesses run day to day. How a job gets booked. How a technician is dispatched. How a fault is diagnosed and fixed. How a supplier order is chased.

That knowledge sits inside established businesses, in job management systems, spreadsheets, ticket queues and maintenance logs. An **AI data buyer** pays the business for an anonymised copy of those records. The buyer uses them to train and test AI systems that need to understand real work.

You are not selling your business. You are selling, or licensing, a copy of records your business already creates.

## What kind of data do AI data buyers want?

The short answer is **operational data**. That means records of process, not records of people.

| Usually wanted (operational) | Not what is being bought (personal) |
|---|---|
| Job and service history | Customer names and addresses |
| Scheduling and dispatch records | Phone numbers and email addresses |
| Maintenance and repair logs | Payment and card details |
| Workflows and standard operating procedures | Health or financial records about individuals |
| Quotes, work orders and process notes | Anything that identifies a person |

Everything is **anonymised** before it leaves you. Anonymised means identifying details are removed so a record cannot reasonably be traced back to an individual. If you want to understand which records carry the most weight, read [what operational data is worth](/guides/what-is-operational-data-worth).

## Who can sell their data?

Our partner is looking for **established businesses**: firms that have run real jobs, real processes and kept real records for a number of years. Start-ups with a few months of history are usually not a fit.

The business does not need to be trading. If you [closed or sold a business but kept its records](/guides/closed-business-data-value), those records may still be worth something. One caveat: if a company went through liquidation, the records may belong to the liquidator rather than the former owner.

## How does the process work?

1. **Claim a valuation.** You give a few details about the business and the records you hold. It takes about a minute on [our data page](/).
2. **The buyer reviews what you have.** Our partner looks at the type, depth and span of your records and how they are stored.
3. **You get a number.** The buyer puts a value on the data. Deals typically land between $200,000 and $2 million.
4. **You decide.** If the number works, you proceed to a contract. If it does not, you walk away.
5. **Anonymise and transfer.** Records are anonymised and handed over under the agreed terms. Your business carries on exactly as before.

## Is selling your business data safe?

It can be, if it is done properly. Our practical view is that three checks matter more than anything else:

- **Privacy obligations.** Check what your privacy policy and local privacy law allow you to do with records you collected. Check the rules in your state or country.
- **Contracts.** Some customer, franchise, software or supplier agreements limit how data can be used or who owns it. Read them, or have your lawyer read them, before you sign anything.
- **Anonymisation.** Make sure the deal spells out what is removed and who does it.

If any of those three is unclear, stop and get advice. A buyer with serious money committed will expect you to have done this.

## What can you do with the money?

Because there is no equity sold and no loan taken, the cash goes onto your balance sheet without strings. Owners commonly use it to:

- **Recapitalise** the business without bringing in an investor or diluting shareholders.
- **Pay down debt**, such as an overdraft or equipment loans, which takes the repayments off monthly cash flow.
- **Fund a new product**, location or hire that has been on hold.

**Illustrative example.** A field-services business has eight years of job records in its scheduling software. The owner claims a valuation, the buyer reviews a sample, and the offer lands at, say, $450,000. The owner uses it to clear an equipment loan and a working-capital overdraft. Nothing changes for staff or customers on Monday morning. This is illustrative only, not a quote or a typical result.

## Why now?

Until recently, nobody was paying for this kind of data. Now AI companies need it, and our partner has around $1 billion committed to buying it. Budgets like this are deployed over time, so there is no guarantee prices or demand stay where they are.

## Disclosure

G&L M&A Advisory may receive a referral fee from our partner. It does not reduce what you are paid. This guide is general information, not financial, legal or tax advice.

## Find out what your data is worth

If you have run an established business, trading or closed, the first step is a number. [Claim my data valuation](/) and we will send you on to our partner to get it.`,
    faqs: [
      {
        q: 'Can I sell my company data to AI companies?',
        a: 'Yes, if it is operational data you have the right to sell and it is anonymised first. Check your privacy obligations and any contracts that limit how the data can be used.',
      },
      {
        q: 'How much do AI companies pay for business data?',
        a: 'It depends on the type, depth and span of your records. Deals through our partner typically land between $200,000 and $2 million, but there is no guaranteed figure.',
      },
      {
        q: 'Do I have to sell customer data?',
        a: 'No. The buyer wants anonymised operational data such as workflows, job history and scheduling. Customer names, contact details and payment data are not what is being bought.',
      },
      {
        q: 'Do I give up equity or control of my business?',
        a: 'No. Selling data involves no equity, no loan and no change of control. Your business keeps running exactly as before.',
      },
      {
        q: 'Can a closed business sell its data?',
        a: 'Often, yes, if the former owner still holds the records. If the company went through liquidation, the records may belong to the liquidator.',
      },
      {
        q: 'Does G&L get paid for referring me?',
        a: 'G&L M&A Advisory may receive a referral fee from our partner. It does not reduce what you are paid.',
      },
    ],
    related: ['what-is-operational-data-worth', 'closed-business-data-value'],
    host: 'data',
    section: 'Selling your data',
    published: '2026-10-14',
    updated: '2026-10-14',
  },
  {
    slug: 'closed-business-data-value',
    title: 'Closed Business Data Value: Can Old Records Still Pay?',
    description:
      'Closed or sold a business but kept its records? Learn why anonymised operational data from a closed business can still be worth money, and who owns it.',
    h1: 'Is the Data From a Closed Business Still Worth Money?',
    answer:
      'Data from a closed business can still be worth money because AI data buyers value historical operational records, such as job history, scheduling and maintenance logs, regardless of whether the business still trades. If the former owner still holds the records and has the right to sell them, they can often be anonymised and sold. If the company was liquidated, the records may belong to the liquidator.',
    keyPoints: [
      'AI data buyers value years of real operating history, and that history does not expire when the doors close.',
      'Closed, sold and dormant businesses can qualify if the owner still holds the records and has the right to sell them.',
      'If the company went through liquidation, the records may belong to the liquidator.',
      'Deals through our partner typically land between $200,000 and $2 million. Only anonymised operational data is sold.',
      'Check privacy obligations and any sale or contract terms before selling.',
    ],
    body: `## Why would anyone pay for data from a business that has closed?

AI companies need examples of how real work gets done. A record of how a job was booked, scheduled, completed and invoiced in 2019 teaches a model just as much as one from last week. The process is what matters, not whether the business is still open.

So the years of job history, scheduling and operations you built up did not stop being useful when you shut the doors. To an **AI data buyer**, that history is a dataset. Our partner has around $1 billion committed to buying anonymised operational data, and closed businesses are in scope.

## Who owns the records after a business closes?

This is the first thing to settle, because you can only sell what you have the right to sell.

| How the business ended | Who usually controls the records | What to check |
|---|---|---|
| Closed voluntarily, debts paid | Often the former owner or company | Company status, privacy obligations |
| Sold the business, kept a copy of records | Depends on the sale agreement | Whether the buyer acquired the data, and any restraint clauses |
| Dormant company, still registered | The company itself | Who can sign on its behalf |
| Liquidation or administration | May belong to the liquidator | Speak to the liquidator before doing anything |

These are general patterns, not legal rules. Check the rules in your state or country, and read your sale agreement if you sold. Many sale contracts transfer the business records to the buyer, which would mean they are no longer yours to sell.

## What records from a closed business are worth looking for?

Look for **operational data**: records of how work was done, not of who the customers were. For example:

- Job management or field-service software exports
- Scheduling and dispatch histories
- Maintenance, service and repair logs
- Work orders, quotes and process notes
- Standard operating procedures and checklists

They might be on an old hard drive, a server in a storage unit, or a cloud account you have not opened in years. If the software subscription has lapsed, contact the vendor. Some keep archived data for a period after cancellation, and some allow an export.

Customer personal data, such as names, phone numbers and payment details, is not what is being bought. Everything is anonymised before transfer. For more on what lifts or lowers a valuation, see [what operational data is worth](/guides/what-is-operational-data-worth).

## How do you sell data from a closed business?

1. **Confirm you have the right to sell.** Work through the table above. If there was a liquidation, start with the liquidator.
2. **Find and gather the records.** Note what systems they came from, how many years they cover and roughly how many jobs or entries there are.
3. **Claim a valuation.** On [our data page](/), choose "Closed", "Sold" or "Dormant" as the business status. It still counts.
4. **Review the offer.** Our partner assesses the records and puts a number on them. Deals typically land between $200,000 and $2 million.
5. **Decide.** If it works, the records are anonymised and transferred under contract. If not, you walk away.

## Illustrative example

A former owner closed a regional maintenance business five years ago. She kept a full export of seven years of work orders and service logs on a backup drive. The company was wound up voluntarily with its debts paid, so the records sit with her. She claims a valuation, the buyer reviews a sample, and the offer is, say, $300,000. She uses it to fund a new venture. This is illustrative only, not a quote or a typical result.

## What kills a closed-business data deal?

In our experience, the deals that stall usually fail on one of these:

- **Ownership is unclear.** The records went to a buyer or liquidator, or a co-owner disputes the sale.
- **The records cannot be found** or cannot be exported from a lapsed system.
- **Privacy or contract limits** that nobody checked before the conversation started.

Sort these out early and the rest is straightforward. The general process is the same as for a trading business, covered in [how to sell your business data to AI companies](/guides/sell-your-business-data-to-ai-companies).

## Disclosure

G&L M&A Advisory may receive a referral fee from our partner. It does not reduce what you are paid. This guide is general information, not financial, legal or tax advice.

## Find out what your old records are worth

That chapter may be closed, but the data from it may not be finished. [Claim my data valuation](/) and pick "Closed" or "Sold" on the form.`,
    faqs: [
      {
        q: 'Can I sell data from a business I closed?',
        a: 'Often, yes, if you still hold the records and have the right to sell them. Only anonymised operational data is sold, not customer personal data.',
      },
      {
        q: 'Who owns business records after liquidation?',
        a: 'If a company went through liquidation, the records may belong to the liquidator rather than the former owner. Speak to the liquidator and check the rules in your state or country.',
      },
      {
        q: 'I sold my business but kept a copy of the records. Can I sell them?',
        a: 'It depends on your sale agreement. Many sale contracts transfer business records to the buyer, so read yours or ask your lawyer before going further.',
      },
      {
        q: 'How old can the data be?',
        a: 'Historical records can still be valuable because buyers want examples of how real work was done. How much the age matters depends on the buyer and the type of work.',
      },
      {
        q: 'What if my old software subscription has lapsed?',
        a: 'Contact the vendor. Some keep archived data for a period after cancellation and allow an export.',
      },
      {
        q: 'How much is data from a closed business worth?',
        a: 'It depends on the type, depth and span of the records. Deals through our partner typically land between $200,000 and $2 million, with no guaranteed figure.',
      },
    ],
    related: ['sell-your-business-data-to-ai-companies', 'what-is-operational-data-worth'],
    host: 'data',
    section: 'Selling your data',
    published: '2026-10-14',
    updated: '2026-10-14',
  },
  {
    slug: 'what-is-operational-data-worth',
    title: 'What Is Operational Data Worth? How Buyers Value It',
    description:
      'What is your operational data worth to AI buyers? What it is, what drives its value, typical deal sizes and how to prepare records for a valuation.',
    h1: 'What Is Operational Data Worth?',
    answer:
      'Operational data is the record of how a business runs: workflows, job and service history, scheduling, maintenance logs and process notes. Its worth to AI data buyers depends on how much there is, how many years it covers, how detailed and consistent it is, and how specialised the work is. Through our partner, deals for anonymised operational data typically land between $200,000 and $2 million.',
    keyPoints: [
      'Operational data records how work is done, not who the customers are.',
      'Value is driven by volume, span of years, detail, consistency and how specialised the work is.',
      'Deals through our partner typically land between $200,000 and $2 million; there is no fixed price per record.',
      'Clean, exportable, well-structured records are easier to value and usually easier to sell.',
      'Only anonymised data is sold. Check privacy obligations and contracts first.',
    ],
    body: `## What is operational data?

**Operational data** is the trail your business leaves as it does its work. It includes:

- **Workflows:** the steps a job or request goes through from enquiry to close.
- **Job and service history:** what was done, when, how long it took and what it needed.
- **Scheduling and dispatch:** who was sent where, and how the day was planned and re-planned.
- **Maintenance logs:** faults found, parts used and fixes applied.
- **Process records:** checklists, standard operating procedures, quotes and work orders.

It is **not** customer personal data. Names, contact details and payment information are not what AI data buyers want, and everything is anonymised before transfer.

## Why is operational data worth anything?

AI models have learnt a lot from the public internet, but very little of it shows real work being done step by step. Operational records do. They show how experienced people make decisions in the real world, including the exceptions, delays and fixes. That is hard to fake and hard to find, which is why our partner has around $1 billion committed to buying it.

## What drives the value of operational data?

There is no published price list, and we will not quote a price per record. What we can tell you is what buyers look at.

| Factor | Higher value | Lower value |
|---|---|---|
| Volume | Many jobs, tickets or entries | A handful of records |
| Span | Many years of history | A few months |
| Detail | Step-by-step notes, timings, outcomes | Just dates and totals |
| Consistency | Same fields, same system, clean format | Mixed formats, gaps, duplicates |
| Specialisation | Skilled, technical or regulated work | Generic admin |
| Accessibility | Exportable from software | Paper files or locked systems |
| Rights | Clear ownership, no contract limits | Disputed or restricted |

Our practitioner view: **detail and span usually matter more than size of business.** A modest firm with ten years of careful job notes can be more interesting than a larger one that only kept invoices.

## How much is operational data worth?

Through our partner, deals typically land between **$200,000 and $2 million**. Where yours falls depends on the factors above. The only reliable way to know is to have the buyer assess what you hold.

**Illustrative example.** Two businesses each claim a valuation.

- Business A has twelve years of detailed service logs in one field-service system, with notes on every job.
- Business B has three years of records spread across spreadsheets and email, mostly dates and invoice totals.

Business A would usually be valued higher, because its records are deeper, longer and cleaner. Both figures would come from the buyer's review, not a formula. This is illustrative only, not a quote or a typical result.

## How do you prepare your records for a valuation?

1. **List your systems.** Note every place operational records live: job software, scheduling tools, ticketing, spreadsheets, shared drives.
2. **Check the span.** Work out how many years each system covers.
3. **Test an export.** See whether you can pull records out in a standard format.
4. **Check your rights.** Review privacy obligations, your privacy policy and any customer, franchise, software or supplier contracts that limit data use. Check the rules in your state or country.
5. **Claim a valuation.** Share what you have on [our data page](/) and let the buyer put a number on it.

## Does selling operational data affect the business?

No. There is no equity sold, no loan and no change of control. Your team and customers notice nothing. The cash can be used to recapitalise, pay down debt or fund a new product. The full process is set out in [how to sell your business data to AI companies](/guides/sell-your-business-data-to-ai-companies).

It also applies if you are no longer trading: see [whether data from a closed business is still worth money](/guides/closed-business-data-value).

## Disclosure

G&L M&A Advisory may receive a referral fee from our partner. It does not reduce what you are paid. This guide is general information, not financial, legal or tax advice.

## Get your number

The value of your operational data is a question only a buyer can answer properly. [Claim my data valuation](/) to find out what yours is worth.`,
    faqs: [
      {
        q: 'What is operational data?',
        a: 'Operational data is the record of how a business runs: workflows, job and service history, scheduling, maintenance logs and process records. It is not customer personal data.',
      },
      {
        q: 'How much is my business data worth?',
        a: 'It depends on volume, span of years, detail, consistency and how specialised the work is. Deals through our partner typically land between $200,000 and $2 million.',
      },
      {
        q: 'Is there a price per record for business data?',
        a: 'Not one we can quote. Buyers value the dataset as a whole, based on its depth, span and quality.',
      },
      {
        q: 'Does a bigger business get a higher data valuation?',
        a: 'Not necessarily. Detailed, consistent records over many years can matter more than the size of the business.',
      },
      {
        q: 'Do paper records count?',
        a: 'They may, but records that can be exported from software are easier to assess and transfer, so they are usually easier to sell.',
      },
      {
        q: 'What should I check before selling operational data?',
        a: 'Check your privacy obligations, your privacy policy and any contracts that limit how data can be used. Make sure the data is anonymised before it leaves you.',
      },
    ],
    related: ['sell-your-business-data-to-ai-companies', 'closed-business-data-value'],
    host: 'data',
    section: 'Selling your data',
    published: '2026-10-14',
    updated: '2026-10-14',
  },
];
