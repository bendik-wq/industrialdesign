/* Funnel HQ financial model: monthly unit economics for the VSL and webinar funnels.
   Plain functions, no DOM, so the dashboard runs it live as you type and the tests import it. */
(function (root) {
  'use strict';

  // Starting assumptions. Every one is editable; the dashboard shows live numbers next to them when there's enough data.
  var DEFAULTS = {
    shared: { currency: 'USD', fee: 22500, refund: 0.05, upfront: 0.7, commission: 0.1, fulfil: 2500, fixed: 8000, months: 12, growth: 0.05, target: 50000 },
    vsl: { on: true, spend: 10000, cpc: 5, optin: 0.05, appDone: 0.6, qualified: 0.3, book: 0.7, show: 0.7, close: 0.15 },
    webinar: {
      on: true, spend: 6000, cpc: 3, reg: 0.25, attend: 0.35, applyAtt: 0.1, applyNo: 0.02, qualified: 0.35, book: 0.7, show: 0.75, close: 0.2,
      // The paid ladder: ticket to watch → First Deal Sprint sold in the room → advisory engagement (Sprint fee credited).
      ladder: true, ticket: 100, ticketBuy: 0.5, sprintPrice: 3000, sprintRate: 0.08, sprintToEng: 0.3, engFee: 50000, sprintCost: 500,
    },
  };

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function div(a, b) { return b > 0 ? a / b : null; }

  /** Fill gaps with defaults and clamp rates to 0..1 so a typo can't break the maths. */
  function normalise(m) {
    m = m || {};
    var out = {};
    ['shared', 'vsl', 'webinar'].forEach(function (k) {
      var d = DEFAULTS[k], src = m[k] || {}, o = {};
      Object.keys(d).forEach(function (f) {
        if (typeof d[f] === 'boolean') o[f] = src[f] == null ? d[f] : Boolean(src[f]);
        else if (typeof d[f] === 'string') o[f] = typeof src[f] === 'string' && /^[A-Z]{3}$/.test(src[f]) ? src[f] : d[f];
        else o[f] = Math.max(0, num(src[f], d[f]));
      });
      out[k] = o;
    });
    ['refund', 'upfront', 'commission'].forEach(function (f) { out.shared[f] = Math.min(1, out.shared[f]); });
    ['optin', 'appDone', 'qualified', 'book', 'show', 'close'].forEach(function (f) { out.vsl[f] = Math.min(1, out.vsl[f]); });
    ['reg', 'attend', 'applyAtt', 'applyNo', 'qualified', 'book', 'show', 'close', 'ticketBuy', 'sprintRate', 'sprintToEng'].forEach(function (f) { out.webinar[f] = Math.min(1, out.webinar[f]); });
    // Scenarios saved before the ladder existed keep their free-webinar numbers until the ladder is switched on.
    var w = m.webinar;
    if (w && typeof w === 'object' && Object.keys(w).length && w.ladder == null) out.webinar.ladder = false;
    out.shared.months = Math.max(1, Math.min(36, Math.round(out.shared.months)));
    out.shared.growth = Math.min(1, out.shared.growth);
    return out;
  }

  /** One funnel for one month at a given spend. kind: 'vsl' | 'webinar'. */
  function funnel(kind, f, s, spendOverride) {
    var spend = spendOverride == null ? f.spend : spendOverride;
    var visitors = f.cpc > 0 ? spend / f.cpc : 0;
    var steps = [{ key: 'visitors', label: 'Landing-page visitors', n: visitors }];
    var apps, leads, ladder = kind === 'webinar' && f.ladder, tickets = 0, sprints = 0, engagements = 0;
    if (kind === 'vsl') {
      leads = visitors * f.optin;
      apps = leads * f.appDone;
      steps.push({ key: 'leads', label: 'Gave contact details', n: leads }, { key: 'apps', label: 'Finished the application', n: apps });
    } else {
      leads = visitors * f.reg;
      // With the paid ladder only ticket holders watch; the Sprint is sold to watchers, and some Sprint buyers sign the engagement.
      var seats = ladder ? leads * f.ticketBuy : leads;
      var att = seats * f.attend;
      apps = att * f.applyAtt + (seats - att) * f.applyNo;
      steps.push({ key: 'leads', label: 'Registered', n: leads });
      if (ladder) { tickets = seats; steps.push({ key: 'tickets', label: 'Bought a ticket', n: tickets }); }
      steps.push({ key: 'attended', label: 'Watched (live or replay)', n: att });
      if (ladder) {
        sprints = att * f.sprintRate;
        engagements = sprints * f.sprintToEng;
        steps.push({ key: 'sprints', label: 'Bought the First Deal Sprint', n: sprints }, { key: 'engagements', label: 'Signed the engagement', n: engagements });
      }
      steps.push({ key: 'apps', label: 'Applied', n: apps });
    }
    var qual = apps * f.qualified, booked = qual * f.book, held = booked * f.show, callDeals = held * f.close, deals = callDeals + engagements;
    steps.push({ key: 'qualified', label: 'Qualified ($1M+)', n: qual }, { key: 'booked', label: 'Booked a call', n: booked }, { key: 'held', label: 'Showed up', n: held }, { key: 'deals', label: ladder ? 'Clients won (calls + Sprint engagements)' : 'Clients won', n: deals });

    // Revenue: tickets, Sprints, the engagement less the Sprint fee credited against it, and clients won on calls.
    var ticketRev = tickets * (f.ticket || 0), sprintRev = sprints * (f.sprintPrice || 0), engRev = engagements * Math.max(0, (f.engFee || 0) - (f.sprintPrice || 0));
    var closerRev = callDeals * s.fee + engRev;
    var gross = ticketRev + sprintRev + closerRev, refunds = gross * s.refund, net = gross - refunds;
    var commission = closerRev * (1 - s.refund) * s.commission, fulfil = deals * s.fulfil + sprints * (ladder ? f.sprintCost || 0 : 0);
    var profit = net - commission - fulfil - spend;
    var margin = s.fee * (1 - s.refund) * (1 - s.commission) - s.fulfil; // what one client leaves after refunds, commission and delivery
    var contribution = profit + spend; // everything the funnel leaves before ads
    return {
      kind: kind, spend: spend, steps: steps, visitors: visitors, leads: leads, apps: apps, qualified: qual, booked: booked, held: held, deals: deals,
      tickets: tickets, sprints: sprints, engagements: engagements, revenue: { tickets: ticketRev, sprints: sprintRev, engagements: engRev, calls: callDeals * s.fee },
      gross: gross, refunds: refunds, net: net, commission: commission, fulfil: fulfil, profit: profit,
      cashNow: net * s.upfront - commission * s.upfront - fulfil - spend,
      unit: {
        perLead: div(spend, leads), perApp: div(spend, apps), perQualified: div(spend, qual), perBooked: div(spend, booked), perHeld: div(spend, held),
        cac: div(spend, deals), roas: div(net, spend), profitPerDollar: div(profit, spend), clientMargin: margin,
        perTicket: div(spend, tickets), perSprint: div(spend, sprints),
        // Fladlien's number: revenue per registrant (and per ticket), across the whole ladder.
        revPerRegistrant: div(net, leads), revPerTicket: div(net, tickets),
        // Break-even points: the most you can pay and still not lose money on ads.
        maxCac: deals > 0 ? contribution / deals : margin, maxPerBooked: booked > 0 && !ladder ? contribution / booked : margin * f.show * f.close, maxPerHeld: margin * f.close,
        maxCpc: visitors > 0 ? contribution / visitors : null,
      },
    };
  }

  function combine(m) {
    var s = m.shared, parts = [];
    if (m.vsl.on) parts.push(funnel('vsl', m.vsl, s));
    if (m.webinar.on) parts.push(funnel('webinar', m.webinar, s));
    var t = { spend: 0, deals: 0, gross: 0, net: 0, commission: 0, fulfil: 0, profit: 0, booked: 0, held: 0, cashNow: 0 };
    parts.forEach(function (p) { Object.keys(t).forEach(function (k) { t[k] += p[k]; }); });
    t.fixed = s.fixed;
    t.profitAfterFixed = t.profit - s.fixed;
    t.cac = div(t.spend, t.deals);
    t.roas = div(t.net, t.spend);
    // Profit scales with spend at today's rates, so the spend for a target profit is one division (at the current VSL/webinar mix).
    var perDollar = div(t.profit, t.spend);
    t.spendForTarget = perDollar && perDollar > 0 ? (s.target + s.fixed) / perDollar : null;
    t.breakEvenSpend = perDollar && perDollar > 0 ? s.fixed / perDollar : null;
    return { parts: parts, total: t };
  }

  /** Month-by-month: spend grows each month; the part of the fee not paid upfront arrives the month after. */
  function projection(m) {
    var s = m.shared, rows = [], cum = 0, prevNet = 0;
    for (var i = 0; i < s.months; i++) {
      var g = Math.pow(1 + s.growth, i), row = { month: i + 1, spend: 0, deals: 0, net: 0, profit: 0, cash: 0 };
      ['vsl', 'webinar'].forEach(function (k) {
        if (!m[k].on) return;
        var p = funnel(k, m[k], s, m[k].spend * g);
        row.spend += p.spend; row.deals += p.deals; row.net += p.net; row.profit += p.profit;
        row.costs = (row.costs || 0) + p.commission + p.fulfil;
      });
      row.profit -= s.fixed;
      row.cash = row.net * s.upfront + prevNet * (1 - s.upfront) - row.spend - (row.costs || 0) - s.fixed;
      prevNet = row.net;
      cum += row.cash;
      row.cumCash = cum;
      rows.push(row);
    }
    var low = rows.reduce(function (a, r) { return Math.min(a, r.cumCash); }, 0);
    // Payback: the first month from which cumulative cash stays at or above zero.
    var payback = null;
    for (var j = rows.length - 1; j >= 0 && rows[j].cumCash >= 0; j--) payback = rows[j].month;
    return { rows: rows, cashNeeded: low < 0 ? -low : 0, paybackMonth: payback };
  }

  /** Profit for one funnel across close rates (rows) and cost per visitor (columns). */
  function sensitivity(kind, m) {
    var f = m[kind], s = m.shared, closes = [0.5, 0.75, 1, 1.25, 1.5], cpcs = [0.5, 0.75, 1, 1.25, 1.5];
    return {
      cols: cpcs.map(function (x) { return f.cpc * x; }),
      rows: closes.map(function (c) {
        var close = Math.min(1, f.close * c);
        return { close: close, cells: cpcs.map(function (x) { var g = {}; Object.keys(f).forEach(function (k) { g[k] = f[k]; }); g.close = close; g.cpc = f.cpc * x; return funnel(kind, g, s).profit; }) };
      }),
    };
  }

  var api = { DEFAULTS: DEFAULTS, normalise: normalise, funnel: funnel, combine: combine, projection: projection, sensitivity: sensitivity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FinModel = api;
})(this);
