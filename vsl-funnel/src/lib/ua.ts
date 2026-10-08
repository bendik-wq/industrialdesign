export interface ParsedUA {
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  device: 'mobile' | 'tablet' | 'desktop' | 'bot';
  isBot: boolean;
  botReason?: string;
}

const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|embedly|quora link|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|slackbot|linkedinbot|twitterbot|skypeuripreview|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|scrapy|node-fetch|axios\/|undici|postmanruntime|insomnia|ahrefs|semrush|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|anthropic-ai|ccbot|perplexity|amazonbot|applebot|yandex|baiduspider|duckduckbot|bingpreview|google-inspectiontool|googleother|adsbot|mediapartners/i;

function match(ua: string, re: RegExp) {
  const m = ua.match(re);
  return m?.[1]?.replace(/_/g, '.') ?? '';
}

export function parseUA(ua: string | null | undefined): ParsedUA {
  const s = ua ?? '';
  if (!s || s.length < 12) return { browser: 'unknown', browserVersion: '', os: 'unknown', osVersion: '', device: 'bot', isBot: true, botReason: 'empty-ua' };

  const botMatch = s.match(BOT_RE);

  let browser = 'Other';
  let browserVersion = '';
  // In-app browsers first: they matter for paid social attribution.
  if (/FBAN|FBAV|FB_IAB/.test(s)) [browser, browserVersion] = ['Facebook In-App', match(s, /FBAV\/([\d.]+)/)];
  else if (/Instagram/.test(s)) [browser, browserVersion] = ['Instagram In-App', match(s, /Instagram ([\d.]+)/)];
  else if (/musical_ly|TikTok|BytedanceWebview/i.test(s)) [browser, browserVersion] = ['TikTok In-App', ''];
  else if (/LinkedInApp/.test(s)) [browser, browserVersion] = ['LinkedIn In-App', ''];
  else if (/Edg(?:e|A|iOS)?\/([\d.]+)/.test(s)) [browser, browserVersion] = ['Edge', match(s, /Edg(?:e|A|iOS)?\/([\d.]+)/)];
  else if (/OPR\/|Opera/.test(s)) [browser, browserVersion] = ['Opera', match(s, /(?:OPR|Opera)\/([\d.]+)/)];
  else if (/SamsungBrowser\/([\d.]+)/.test(s)) [browser, browserVersion] = ['Samsung Internet', match(s, /SamsungBrowser\/([\d.]+)/)];
  else if (/CriOS\/([\d.]+)/.test(s)) [browser, browserVersion] = ['Chrome', match(s, /CriOS\/([\d.]+)/)];
  else if (/FxiOS\/([\d.]+)/.test(s)) [browser, browserVersion] = ['Firefox', match(s, /FxiOS\/([\d.]+)/)];
  else if (/Firefox\/([\d.]+)/.test(s)) [browser, browserVersion] = ['Firefox', match(s, /Firefox\/([\d.]+)/)];
  else if (/Chrome\/([\d.]+)/.test(s)) [browser, browserVersion] = ['Chrome', match(s, /Chrome\/([\d.]+)/)];
  else if (/Version\/([\d.]+).*Safari/.test(s)) [browser, browserVersion] = ['Safari', match(s, /Version\/([\d.]+)/)];

  let os = 'Other';
  let osVersion = '';
  if (/iPhone|iPad|iPod/.test(s)) [os, osVersion] = ['iOS', match(s, /OS ([\d_]+) like Mac/)];
  else if (/Android/.test(s)) [os, osVersion] = ['Android', match(s, /Android ([\d.]+)/)];
  else if (/Windows NT/.test(s)) [os, osVersion] = ['Windows', match(s, /Windows NT ([\d.]+)/)];
  else if (/Mac OS X/.test(s)) [os, osVersion] = ['macOS', match(s, /Mac OS X ([\d_.]+)/)];
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';

  let device: ParsedUA['device'] = 'desktop';
  if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android/.test(s)) device = 'mobile';

  if (botMatch) return { browser, browserVersion, os, osVersion, device: 'bot', isBot: true, botReason: botMatch[0].toLowerCase() };
  return { browser, browserVersion, os, osVersion, device, isBot: false };
}
