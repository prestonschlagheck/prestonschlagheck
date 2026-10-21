// Draws the profile: README.md from profile.json, plus its images (social pills and the contribution
// ticker) in light and dark, written to dist/. The workflow publishes dist/ to
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
const LOSS = '#ff5000';

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

// Robinhood's stock page, played as a loop. For each range a dot draws the line left to right while
// the count and the change against the period before tick up with it, then the next range starts.
// Everything is SMIL on one shared clock, so it runs inside GitHub's <img> with no script.
// Longest first, so the first thing a visitor sees is the biggest number. 1Y only appears once
// there is more than a year of history to compare it against.
const RANGES = [
	{ tab: '1Y', days: 365, smooth: 7, versus: 'vs previous year' },
	{ tab: '9M', days: 273, smooth: 6, versus: 'vs previous 9 months' },
	{ tab: '6M', days: 182, smooth: 5, versus: 'vs previous 6 months' },
	{ tab: '3M', days: 91, smooth: 3, versus: 'vs previous 3 months' },
];
const DRAW = 4.2, HOLD = 2.6, FADE = 0.45; // seconds per range
const FRAMES = 110; // count updates per draw, about 26 a second

function ticker(theme, profile, cal) {
	const t = THEMES[theme];
	const gain = GAIN[theme];
	const W = 880, H = 448, top = 184, bottom = 326;
	const { days } = cal;
	const s = stats(days);
	const slot = DRAW + HOLD + FADE;
	const active = RANGES.filter((r) => r.days < 365 || days.length > 365);
	const T = slot * active.length;
	const kt = (sec) => +Math.min(1, Math.max(0, sec / T)).toFixed(5);
	const sum = (a, b) => days.slice(Math.max(0, a), Math.max(0, b)).reduce((n, d) => n + d.count, 0);

	const ranges = active.map((r, k) => {
		const span = Math.min(r.days, days.length);
		const start = days.length - span;
		const total = sum(start, days.length);
		const prev = sum(start - r.days, start);
		const pct = prev > 0 ? Math.round(((total - prev) / prev) * 100) : null;
		// Trailing r.smooth-day total per day. Plotted point to point, so it stays jagged.
		const series = days.slice(start).map((_, i) => sum(start + i - r.smooth + 1, start + i + 1));
		const max = Math.max(1, ...series);
		// The line stops short of the right edge so the 4.5px dot (and its ring) never clips.
		const pts = series.map((v, i) => [(i / Math.max(1, span - 1)) * (W - 8), bottom - (v / max) * (bottom - top)]);
		// Cumulative count and cumulative path length at each point, so the counter and the dot
		// both track the line's x position rather than time or arc length.
		const cum = [], len = [0];
		series.forEach((_, i) => (cum[i] = (cum[i - 1] ?? 0) + days[start + i].count));
		for (let i = 1; i < pts.length; i++) len[i] = len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
		const L = len.at(-1) || 1;
		const at = (f, arr) => {
			const x = f * (pts.length - 1), i = Math.floor(x), j = Math.min(i + 1, pts.length - 1);
			return arr[i] + (arr[j] - arr[i]) * (x - i);
		};
		const frames = Array.from({ length: FRAMES + 1 }, (_, j) => {
			// u is time through the draw, f is how far along the line the dot is: eased in and out.
			const u = j / FRAMES;
			const f = 0.5 - 0.5 * Math.cos(Math.PI * u);
			const count = j === FRAMES ? total : Math.round(at(f, cum));
			return { u, f, count, pct: pct === null ? null : Math.round((pct * count) / Math.max(1, total)), len: at(f, len) / L };
		});
		const d = 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L');
		return { ...r, k, t0: k * slot, total, pct, d, frames, end: pts.at(-1) };
	});

	// Visible for its own slot only. Keyframes are nudged apart so no two land on the same time.
	const showing = (r) => {
		const a = r.t0, b = r.t0 + DRAW + HOLD, c = b + FADE;
		const keys = r.k === 0 ? [[0, 1], [b, 1], [c, 0], [T, 0]] : [[0, 0], [a - 0.001, 0], [a, 1], [b, 1], [c, 0], [T, 0]];
		return `<animate attributeName="opacity" values="${keys.map((x) => x[1]).join(';')}" keyTimes="${keys.map((x) => kt(x[0])).join(';')}" dur="${T}s" repeatCount="indefinite"/>`;
	};
	// The count and the change, re-set as plain text for each frame of the draw. Each frame's text is
	// shown only until the next one, which renders the same in every browser and keeps the number
	// left aligned with its label riding along after it.
	const ticking = (r, text) => {
		const shown = [];
		r.frames.forEach((fr) => {
			const s = text(fr);
			if (shown.at(-1)?.s !== s) shown.push({ s, at: r.t0 + fr.u * DRAW });
		});
		return shown
			.map(({ s, at }, j) => {
				const next = shown[j + 1]?.at;
				const keys = j === 0 ? [[0, 1]] : [[0, 0], [at, 1]];
				if (next !== undefined) keys.push([next, 0]);
				const last = j === shown.length - 1;
				return `<g opacity="${last ? 1 : 0}"><animate attributeName="opacity" values="${keys.map((x) => x[1]).join(';')}" keyTimes="${keys.map((x) => kt(x[0])).join(';')}" calcMode="discrete" dur="${T}s" repeatCount="indefinite"/>${s}</g>`;
			})
			.join('');
	};

	const groups = ranges
		.map((r) => {
			const up = r.pct === null || r.pct >= 0;
			const tone = up ? gain : LOSS;
			const big = `<g class="big">${ticking(r, (fr) => `<text y="104">${fmt(fr.count)}<tspan dx="12" class="lbl">contributions</tspan></text>`)}</g>`;
			const sub =
				r.pct === null
					? `<text x="0" y="138" font-size="15" fill="${t.muted}">Past ${r.days === 365 ? 'year' : `${r.days} days`}</text>`
					: `<g class="sub" fill="${tone}">${ticking(r, (fr) => `<text y="138">${up ? '+' : '−'}${fmt(Math.abs(fr.pct))}%<tspan class="vs"> ${r.versus}</tspan></text>`)}</g>`;
			// The clip widens with x at a constant rate, and the dot rides the path to match it.
			const keyPoints = r.frames.map((fr) => fr.len.toFixed(4));
			const motion = [[0, 0], ...(r.t0 > 0 ? [[r.t0 - 0.001, 0]] : []), ...r.frames.map((fr, j) => [r.t0 + fr.u * DRAW, keyPoints[j]]), [T, 1]];
			return `<g opacity="${r.k === 0 ? 1 : 0}">${showing(r)}
<defs><clipPath id="c${r.k}"><rect x="-4" y="0" width="${W + 8}" height="${H}"><animate attributeName="width" values="${r.t0 > 0 ? '0;' : ''}${r.frames.map((fr) => (fr.f * (W - 8) + 4).toFixed(1)).join(';')};${W + 8}" keyTimes="${r.t0 > 0 ? '0;' : ''}${r.frames.map((fr) => kt(r.t0 + fr.u * DRAW)).join(';')};1" dur="${T}s" repeatCount="indefinite"/></rect></clipPath></defs>
<path id="p${r.k}" d="${r.d}" fill="none" stroke="${gain}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#c${r.k})"/>
<circle r="4.5" fill="${gain}" cx="0" cy="0"><animateMotion dur="${T}s" repeatCount="indefinite" calcMode="linear" keyPoints="${motion.map((m) => m[1]).join(';')}" keyTimes="${motion.map((m) => kt(m[0])).join(';')}"><mpath href="#p${r.k}"/></animateMotion></circle>
${big}
${sub}
</g>`;
		})
		.join('\n');

	const tabW = 52, tabY = 362;
	const ul = [];
	ranges.forEach((r) => {
		ul.push([r.t0 + (r.k ? 0.001 : 0), r.k * tabW + 10]);
		ul.push([r.t0 + DRAW + HOLD + FADE - 0.002, r.k * tabW + 10]);
	});
	ul[0][0] = 0;
	ul.push([T, 10]);
	const underline = `<rect x="10" y="${tabY + 10}" width="${tabW - 20}" height="2" rx="1" fill="${gain}"><animate attributeName="x" values="${ul.map((u) => u[1]).join(';')}" keyTimes="${ul.map((u) => kt(u[0])).join(';')}" dur="${T}s" repeatCount="indefinite"/></rect>`;
	const tabs = ranges
		.map((r) => `<text x="${r.k * tabW + tabW / 2}" y="${tabY}" text-anchor="middle" fill="${t.ink}">${r.tab}</text><text x="${r.k * tabW + tabW / 2}" y="${tabY}" text-anchor="middle" fill="${gain}" opacity="${r.k === 0 ? 1 : 0}">${r.tab}${showing(r)}</text>`)
		.join('');
	const dots = Array.from({ length: Math.floor(W / 7) }, (_, k) => `<circle cx="${(k * 7 + 3.5).toFixed(1)}" cy="${bottom + 0.5}" r="1"/>`).join('');
	const statsRow = [
		['Contributions', fmt(cal.total)],
		['Longest streak', `${s.longest} days`],
		['Best day', fmt(s.best.count)],
		['Days shipped', `${fmt(s.active)} of ${fmt(days.length)}`],
	]
		.map(([k, v], i) => `<text x="${i * (W / 4)}" y="${H - 30}" font-size="13" fill="${t.muted}">${k}</text><text x="${i * (W / 4)}" y="${H - 7}" font-size="17" font-weight="600" fill="${t.ink}">${v}</text>`)
		.join('');

	const since = new Date(days[0].date + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
	const label = `${profile.fullName}: ${fmt(cal.total)} GitHub contributions since ${since}, ${fmt(ranges[0].total)} in the past month`;
	const body = `
<style>.big{font-size:44px;font-weight:700;letter-spacing:-1px;fill:${t.ink}}.lbl{font-size:15px;font-weight:400;letter-spacing:0;fill:${t.muted}}.sub{font-size:15px;font-weight:600}.vs{font-weight:400;fill:${t.muted}}</style>
<text x="0" y="34" font-size="26" font-weight="700" fill="${t.ink}" letter-spacing="-0.4">${esc(profile.fullName)}</text>
<g fill="${t.rule}" fill-opacity="${(t.ruleOp * 2.2).toFixed(2)}">${dots}</g>
${groups}
<g font-size="13" font-weight="700" letter-spacing="0.3">${tabs}</g>
${underline}
<rect x="0" y="${tabY + 24}" width="${W}" height="1" fill="${t.rule}" fill-opacity="${t.ruleOp}"/>
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
		.map(([title, items]) => `#### ${title}\n\n${items.map((i) => `- ${i.head}\n${i.points.map((pt) => `  - ${pt}`).join('\n')}`).join('\n')}`)
		.join('\n\n');
	return `<!-- Generated by .profile/render.mjs from profile.json. Edit profile.json, not this file. -->

<p>${socials.map(([name, href, alt]) => `<a href="${href}">${picture(name, alt, 'height="32"')}</a>`).join('\n')}</p>

<p>${picture('ticker', `$${p.ticker} contribution chart`, 'width="100%"')}</p>

${p.intro.join('\n\n')}

${sections}

`;
}

// ---- Main -------------------------------------------------------------------------------------

const profile = JSON.parse(await readFile('profile.json', 'utf8'));
const cal = await calendar(LOGIN);
// Lifetime contributions never go down. A lower count than the published chart means the token
// can't see private contributions (the profile setting is off), so keep the published images.
const published = await fetch(`${RAW}/ticker-dark.svg`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
const was = Number(published.match(/: ([\d,]+) GitHub contributions/)?.[1].replace(/,/g, '') ?? 0);
if (cal.total < was) {
	console.log(`Skipping: found ${fmt(cal.total)} contributions, below the ${fmt(was)} already published`);
	process.exit(0);
}
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
	for (const [name, content] of Object.entries(files)) await writeFile(`${OUT}/${name}-${theme}.svg`, content);
}
await writeFile('README.md', readme(profile));
console.log(`Rendered ${fmt(cal.total)} contributions for ${LOGIN}`);
