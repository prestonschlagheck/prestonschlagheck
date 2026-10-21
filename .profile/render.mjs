// Draws the profile: README.md from profile.json, plus its images (social pills, the contribution
// ticker, featured repo pills) in light and dark, written to dist/. The workflow publishes dist/ to
// the `output` branch, which the README points at. Node 20+, no dependencies.
//
//   LOGIN=prestonschlagheck GITHUB_TOKEN=$(gh auth token) node .profile/render.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const LOGIN = process.env.LOGIN;
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = 'dist';
if (!LOGIN || !TOKEN) throw new Error('LOGIN and GITHUB_TOKEN are required');

const RAW = process.env.RAW_BASE ?? `https://raw.githubusercontent.com/${LOGIN}/${LOGIN}/output`;
const FONT = `-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Helvetica,Arial,sans-serif`;
// The ticker sits straight on the page with no card, so only ink and rules change with the theme.
const THEMES = {
	dark: { ink: '#f0f6fc', muted: '#8b949e', rule: '#ffffff', ruleOp: 0.12, chip: '#161b22', edge: '#ffffff', edgeOp: 0.1 },
	light: { ink: '#1f2328', muted: '#656d76', rule: '#1f2328', ruleOp: 0.14, chip: '#f6f8fa', edge: '#1f2328', edgeOp: 0.12 },
};
const GAIN = { dark: '#00c805', light: '#00a804' };

const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) =>
	String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svg = (w, h, label, body) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" role="img" aria-label="${esc(label)}">${body}</svg>`;

// No font metrics without a dependency, so pills are sized from rough per-glyph widths (em).
function textWidth(s, size, bold = false) {
	let em = 0;
	for (const c of s) {
		if ('il.,:;|!\'ij'.includes(c)) em += 0.27;
		else if (c === ' ') em += 0.28;
		else if ('mwMW@'.includes(c)) em += 0.86;
		else if (/[A-Z]/.test(c)) em += 0.66;
		else if (/[0-9]/.test(c)) em += 0.58;
		else if ('frt'.includes(c)) em += 0.36;
		else em += 0.55;
	}
	return em * size * (bold ? 1.06 : 1);
}

// ---- Data -------------------------------------------------------------------------------------

async function graphql(query, variables) {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: { authorization: `bearer ${TOKEN}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables }),
	});
	const body = await res.json();
	if (!res.ok || body.errors) throw new Error(`GitHub GraphQL failed: ${JSON.stringify(body.errors ?? body)}`);
	return body.data;
}

// Every day since the account opened. GitHub caps a contributions query at one year, so this walks
// forward a year at a time.
async function calendar(login) {
	const { user } = await graphql(`query($login: String!) { user(login: $login) { createdAt } }`, { login });
	const now = new Date();
	const days = [];
	for (let from = new Date(user.createdAt); from < now; ) {
		const to = new Date(Math.min(now, Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), from.getUTCDate()) - 1000));
		const data = await graphql(
			`query($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) {
        contributionsCollection(from: $from, to: $to) { contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`,
			{ login, from: from.toISOString(), to: to.toISOString() },
		);
		for (const w of data.user.contributionsCollection.contributionCalendar.weeks)
			for (const d of w.contributionDays) if (!days.length || d.date > days.at(-1).date) days.push({ date: d.date, count: d.contributionCount });
		from = new Date(to.getTime() + 1000);
	}
	// Start the chart at the first day with anything on it.
	const first = days.findIndex((d) => d.count > 0);
	const kept = first < 0 ? days.slice(-1) : days.slice(first);
	return { days: kept, total: kept.reduce((n, d) => n + d.count, 0) };
}

function stats(days) {
	// The streak runs to today, or to yesterday when today has nothing yet.
	let i = days.length - 1, streak = 0;
	if (i >= 0 && days[i].count === 0) i--;
	for (; i >= 0 && days[i].count > 0; i--) streak++;
	let longest = 0, run = 0;
	for (const d of days) longest = Math.max(longest, (run = d.count > 0 ? run + 1 : 0));
	const best = days.reduce((a, d) => (d.count > a.count ? d : a), days[0]);
	return { streak, longest, best, active: days.filter((d) => d.count > 0).length };
}

// ---- Ticker -----------------------------------------------------------------------------------

// Robinhood's stock page, with lifetime contributions as the share price. The price only goes up,
// so each range tab is about how steep the climb is. The chart draws in, then walks through the
// range tabs, morphing the line between them, and loops.
const RANGES = [
	{ tab: '1W', days: 7, label: 'Past week' },
	{ tab: '1M', days: 30, label: 'Past month' },
	{ tab: '3M', days: 91, label: 'Past 3 months' },
	{ tab: 'YTD', days: null, label: 'Year to date' },
	{ tab: '1Y', days: 365, label: 'Past year' },
	{ tab: 'ALL', days: Infinity, label: 'All time' },
];
// Opens on ALL, the whole climb, then tours the shorter ranges and comes back.
const ORDER = [5, 0, 1, 2, 3, 4];
const HOLD = 2.6, HOLD_FIRST = 4.2, MORPH = 0.9, INTRO = 2.4;
const N = 160;

function ticker(theme, profile, cal) {
	const t = THEMES[theme];
	const gain = GAIN[theme];
	const W = 880, H = 448, padX = 2;
	const top = 150, bottom = 318;
	const { days, total } = cal;
	const s = stats(days);

	// cum[i] is the price at the close of day i; cum[-1] (the open before day 0) is 0.
	const cum = [];
	days.reduce((n, d, i) => (cum[i] = n + d.count), 0);
	const at = (i) => (i < 0 ? 0 : cum[Math.min(i, cum.length - 1)]);
	const jan1 = days.findIndex((d) => d.date >= `${new Date().getUTCFullYear()}-01-01`);

	const ranges = RANGES.map((r) => {
		const span = r.days === null ? days.length - Math.max(0, jan1) : Math.min(r.days, days.length);
		const start = days.length - span; // first day inside the range
		const open = at(start - 1), close = at(days.length - 1);
		const lo = open, hi = Math.max(close, open + 1);
		// Resample to N points so every range's path has the same commands and SMIL can morph them.
		const pts = [];
		for (let k = 0; k < N; k++) {
			const f = (k / (N - 1)) * span; // days elapsed since the open
			const i = start - 1 + f;
			const a = at(Math.floor(i)), b = at(Math.ceil(i));
			const v = a + (b - a) * (i - Math.floor(i));
			pts.push([padX + (k / (N - 1)) * (W - padX * 2), bottom - ((v - lo) / (hi - lo)) * (bottom - top)]);
		}
		const d = 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L');
		const change = close - open;
		const pct = open > 0 ? (change / open) * 100 : null;
		return { ...r, d, change, pct };
	});

	// One timeline for every animated attribute: hold, morph, hold, morph... back to the first range.
	const marks = [0];
	ORDER.forEach((_, j) => {
		marks.push(marks.at(-1) + (j === 0 ? HOLD_FIRST : HOLD));
		marks.push(marks.at(-1) + MORPH);
	});
	const T = marks.at(-1);
	const keyTimes = marks.map((m) => (m / T).toFixed(4)).join(';');
	// Value at each mark: mark 2j..2j+1 is the hold on ORDER[j]; the last mark is back on ORDER[0].
	const seq = (f) => marks.map((_, m) => f(ORDER[m === marks.length - 1 ? 0 : Math.floor(m / 2)])).join(';');
	const splines = marks.slice(1).map((_, m) => (m % 2 ? '.45 0 .15 1' : '0 0 1 1')).join(';');
	const anim = (attr, values, extra = '') =>
		`<animate attributeName="${attr}" values="${values}" keyTimes="${keyTimes}" calcMode="spline" keySplines="${splines}" dur="${T}s" begin="${INTRO}s" repeatCount="indefinite"${extra}/>`;
	const first = ranges[ORDER[0]];

	// Price: an odometer per digit that rolls up from zero on load.
	const size = 44, lh = size * 1.25, dw = size * 0.6, cw = size * 0.28, baseY = 104;
	let x = 0;
	const odometer = [...fmt(total)]
		.map((c, i) => {
			if (!/\d/.test(c)) {
				const out = `<text x="${(x + cw / 2).toFixed(1)}" y="${baseY}" text-anchor="middle">${c}</text>`;
				x += cw;
				return out;
			}
			const n = 10 + Number(c);
			const col = Array.from({ length: n + 1 }, (_, k) => `<text x="${(dw / 2).toFixed(1)}" y="${(size * 0.98 + k * lh).toFixed(1)}" text-anchor="middle">${k % 10}</text>`).join('');
			const out = `<svg x="${x.toFixed(1)}" y="${(baseY - size * 0.98).toFixed(1)}" width="${dw.toFixed(1)}" height="${(lh).toFixed(1)}"><g transform="translate(0 ${(-n * lh).toFixed(1)})" style="--to:${(-n * lh).toFixed(1)}px;animation-delay:${(0.1 + i * 0.07).toFixed(2)}s" class="roll">${col}</g></svg>`;
			x += dw;
			return out;
		})
		.join('');

	const change = (r) =>
		`<text x="0" y="138" font-size="15" font-weight="600" fill="${gain}" opacity="${r === first ? 1 : 0}">+${fmt(r.change)}${r.pct === null ? '' : ` (+${r.pct >= 1000 ? fmt(Math.round(r.pct)) : r.pct.toFixed(1)}%)`}<tspan fill="${t.ink}" font-weight="400"> ${r.label}</tspan>${anim('opacity', seq((k) => (ranges[k] === r ? 1 : 0)))}</text>`;

	const tabW = 52, tabY = 362;
	const tabX = (k) => k * tabW;
	const tabs = ranges
		.map((r, k) => {
			const cx = tabX(k) + tabW / 2;
			return `<text x="${cx}" y="${tabY}" text-anchor="middle" fill="${t.ink}">${r.tab}</text><text x="${cx}" y="${tabY}" text-anchor="middle" fill="${gain}" opacity="${r === first ? 1 : 0}">${r.tab}${anim('opacity', seq((j) => (j === k ? 1 : 0)))}</text>`;
		})
		.join('');
	const underline = `<rect x="${tabX(ORDER[0]) + 10}" y="${tabY + 10}" width="${tabW - 20}" height="2" rx="1" fill="${gain}">${anim('x', seq((k) => tabX(k) + 10))}</rect>`;

	// Robinhood's dotted reference line, here the price at the open of the range: always the floor.
	const dots = Array.from({ length: Math.floor(W / 7) }, (_, k) => `<circle cx="${(k * 7 + 3.5).toFixed(1)}" cy="${bottom}" r="1"/>`).join('');

	const statsRow = [
		['Current streak', `${s.streak} days`],
		['Longest streak', `${s.longest} days`],
		['Best day', `${fmt(s.best.count)}`],
		['Days shipped', `${fmt(s.active)} of ${fmt(days.length)}`],
	]
		.map(([k, v], i) => `<text x="${i * (W / 4)}" y="${H - 34}" font-size="13" fill="${t.muted}">${k}</text><text x="${i * (W / 4)}" y="${H - 10}" font-size="17" font-weight="600" fill="${t.ink}">${v}</text>`)
		.join('');

	const since = new Date(days[0].date + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
	const label = `${profile.fullName}: ${fmt(total)} GitHub contributions since ${since}, +${fmt(ranges[1].change)} in the past month`;
	const body = `
<style>
.roll{animation:roll 1.6s cubic-bezier(.15,.85,.25,1) both}
.line{stroke-dasharray:1;animation:draw 2.2s cubic-bezier(.6,0,.2,1) .15s both}
.fade{animation:fade .6s ease 2.2s both}
.ring{transform-box:fill-box;transform-origin:center;animation:ping 1.8s ease-out 2.4s infinite both}
@keyframes roll{from{transform:translateY(0)}to{transform:translateY(var(--to))}}
@keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes ping{0%{transform:scale(1);opacity:.5}75%,100%{transform:scale(3.4);opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<text x="0" y="34" font-size="26" font-weight="700" fill="${t.ink}" letter-spacing="-0.4">${esc(profile.fullName)}</text>
<g font-size="${size}" font-weight="700" fill="${t.ink}" letter-spacing="-1" style="font-variant-numeric:tabular-nums">${odometer}</g>
<text x="${(x + 12).toFixed(1)}" y="${baseY}" font-size="15" fill="${t.muted}">contributions</text>
${ranges.map(change).join('')}
<g fill="${t.rule}" fill-opacity="${t.ruleOp * 2.2}">${dots}</g>
<path class="line" d="${first.d}" pathLength="1" fill="none" stroke="${gain}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${anim('d', seq((k) => ranges[k].d))}</path>
<g class="fade"><circle class="ring" cx="${W - padX}" cy="${top}" r="4.5" fill="${gain}"/><circle cx="${W - padX}" cy="${top}" r="4.5" fill="${gain}"/></g>
<g font-size="13" font-weight="700" letter-spacing="0.3">${tabs}</g>
${underline}
<rect x="0" y="${tabY + 26}" width="${W}" height="1" fill="${t.rule}" fill-opacity="${t.ruleOp}"/>
${statsRow}`;
	return svg(W, H, label, body);
}

// ---- Pills ------------------------------------------------------------------------------------

const ICONS = {
	x: (c) => `<path fill="${c}" transform="scale(.6667)" d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>`,
	linkedin: (c) => `<path fill="${c}" transform="scale(.6667)" d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.064 2.064 0 1 1 0-4.128 2.064 2.064 0 0 1 0 4.128zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>`,
	site: (c) => `<g fill="none" stroke="${c}" stroke-width="1.4"><circle cx="8" cy="8" r="6.6"/><ellipse cx="8" cy="8" rx="2.9" ry="6.6"/><path d="M1.6 6h12.8M1.6 10h12.8"/></g>`,
	email: (c) => `<g fill="none" stroke="${c}" stroke-width="1.4" stroke-linejoin="round"><rect x="1.3" y="3" width="13.4" height="10" rx="2"/><path d="m2 4.2 6 4.6 6-4.6"/></g>`,
	repo: (c) => `<path fill="${c}" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>`,
};

function pill(theme, icon, text, sub) {
	const t = THEMES[theme];
	const H = 32, size = 14;
	const tw = textWidth(text, size, true);
	const sw = sub ? textWidth(sub, 13) + 8 : 0;
	const W = Math.ceil(36 + tw + sw + 14);
	const body = `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="${H / 2 - 0.5}" fill="${t.chip}" stroke="${t.edge}" stroke-opacity="${t.edgeOp}"/>
<g transform="translate(13 8)">${ICONS[icon](t.ink)}</g>
<text x="36" y="21" font-size="${size}" font-weight="600" fill="${t.ink}">${esc(text)}${sub ? `<tspan dx="8" font-size="13" font-weight="400" fill="${t.muted}">${esc(sub)}</tspan>` : ''}</text>`;
	return svg(W, H, sub ? `${text}: ${sub}` : text, body);
}

// ---- README -----------------------------------------------------------------------------------

const picture = (name, alt, attr) =>
	`<picture><source media="(prefers-color-scheme: dark)" srcset="${RAW}/${name}-dark.svg"><img alt="${esc(alt)}" src="${RAW}/${name}-light.svg" ${attr}></picture>`;

function readme(p) {
	const so = p.socials;
	const socials = [
		so.x && ['social-x', `https://x.com/${so.x}`, `X @${so.x}`],
		so.linkedin && ['social-linkedin', `https://linkedin.com/in/${so.linkedin}`, `LinkedIn ${so.linkedin}`],
		so.site && ['social-site', `https://${so.site.replace(/^https?:\/\//, '')}`, so.site],
		so.email && ['social-email', `mailto:${so.email}`, so.email],
	].filter(Boolean);
	const sections = Object.entries(p.sections)
		.map(([title, items]) => `#### ${title}\n\n${items.map((i) => `- <small>${i}</small>`).join('\n')}`)
		.join('\n\n');
	return `<!-- Generated by .profile/render.mjs from profile.json. Edit profile.json, not this file. -->

<p>${socials.map(([name, href, alt]) => `<a href="${href}">${picture(name, alt, 'height="32"')}</a>`).join('\n')}</p>

<p>${picture('ticker', `$${p.ticker} contribution chart`, 'width="100%"')}</p>

## Hey, I'm ${p.name} 👋

${p.intro.map((l) => `<small>${l}</small>`).join('\n\n')}

${sections}

#### Building with

<small>${p.stack.join(' · ')}</small>

<br>

<p>${p.featured.map((f, i) => `<a href="https://github.com/${f.repo}">${picture(`featured-${i + 1}`, `${f.label}: ${f.desc}`, 'height="32"')}</a>`).join('\n')}</p>
`;
}

// ---- Main -------------------------------------------------------------------------------------

const profile = JSON.parse(await readFile('profile.json', 'utf8'));
const cal = await calendar(LOGIN);
await mkdir(OUT, { recursive: true });
const so = profile.socials;
for (const theme of Object.keys(THEMES)) {
	const files = {
		ticker: ticker(theme, profile, cal),
		...(so.x && { 'social-x': pill(theme, 'x', `@${so.x}`) }),
		...(so.linkedin && { 'social-linkedin': pill(theme, 'linkedin', so.linkedin) }),
		...(so.site && { 'social-site': pill(theme, 'site', so.site) }),
		...(so.email && { 'social-email': pill(theme, 'email', 'Email') }),
	};
	profile.featured.forEach((f, i) => (files[`featured-${i + 1}`] = pill(theme, 'repo', f.label, f.desc)));
	for (const [name, content] of Object.entries(files)) await writeFile(`${OUT}/${name}-${theme}.svg`, content);
}
await writeFile('README.md', readme(profile));
console.log(`Rendered ${fmt(cal.total)} contributions for ${LOGIN}`);
