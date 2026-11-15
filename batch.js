/* ==========================================================================
   Batch Resume Ranker
   - Upload many resumes (PDF / DOCX / DOC / TXT), add them in several rounds
   - Scores each resume against ONE job description and ranks best-fit first
   - 100% client-side: nothing is uploaded anywhere (works on GitHub Pages)
   ========================================================================== */
(function () {
    'use strict';

    const MAX_FILES = 200;
    const MAX_FILE_MB = 10;
    const ALLOWED_EXT = ['pdf', 'docx', 'doc', 'txt'];
    const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const state = {
        files: [],          // { id, file, text, status: 'queued'|'reading'|'ready'|'error', error }
        results: [],        // ranked results
        failed: [],         // files that could not be read
        jdSignature: '',    // JD the current results were computed for
        busy: false,
        nextId: 1
    };

    /* ----------------------------------------------------------------------
       Small helpers
       ---------------------------------------------------------------------- */
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const ext = (name) => (name.split('.').pop() || '').toLowerCase();
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const pct = (n) => Math.round(clamp(n, 0, 1) * 100);

    /* ----------------------------------------------------------------------
       Text extraction (PDF / DOCX / DOC / TXT)
       ---------------------------------------------------------------------- */
    async function extractText(file) {
        const e = ext(file.name);
        if (e === 'pdf') return extractPdf(file);
        if (e === 'docx') return extractDocx(file);
        if (e === 'doc') return extractDoc(file);
        return (await file.text()) || '';
    }

    async function extractPdf(file) {
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF reader failed to load. Check your internet connection and refresh.');
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
        const data = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        let out = '';
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            let lastY = null;
            let line = '';
            for (const item of content.items) {
                const y = item.transform ? item.transform[5] : 0;
                if (lastY !== null && Math.abs(y - lastY) > 2) {
                    out += line.trim() + '\n';
                    line = '';
                }
                line += item.str + (item.hasEOL ? '\n' : ' ');
                lastY = y;
            }
            out += line.trim() + '\n';
        }
        return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    async function extractDocx(file) {
        if (typeof mammoth === 'undefined') throw new Error('DOCX reader failed to load. Check your internet connection and refresh.');
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        return (result.value || '').trim();
    }

    async function extractDoc(file) {
        const arrayBuffer = await file.arrayBuffer();
        // Some ".doc" files are really DOCX / HTML in disguise
        if (typeof mammoth !== 'undefined') {
            try {
                const r = await mammoth.extractRawText({ arrayBuffer });
                if (r.value && r.value.trim().length > 50) return r.value.trim();
            } catch (_) { /* fall through */ }
        }
        // Legacy binary .doc: best-effort scrape of readable text runs
        const raw = new TextDecoder('latin1').decode(arrayBuffer);
        const runs = raw.match(/[\x20-\x7E]{6,}/g) || [];
        const text = runs.join('\n');
        if (text.length < 200) throw new Error('Legacy .doc could not be read. Please save it as .docx or PDF.');
        return text;
    }

    /* ----------------------------------------------------------------------
       Skill dictionary (canonical name -> aliases). Used to find hard skills
       in the JD and in each resume.
       ---------------------------------------------------------------------- */
    const SKILLS = {
        // Languages
        'python': ['python', 'python3'], 'java': ['java'], 'javascript': ['javascript', 'js', 'ecmascript', 'es6'],
        'typescript': ['typescript'], 'c++': ['c++', 'cpp'], 'c#': ['c#', 'csharp'], '.net': ['.net', 'dotnet', 'asp.net'],
        'ruby': ['ruby', 'ruby on rails', 'rails'], 'php': ['php'], 'go': ['golang'], 'rust': ['rust'],
        'kotlin': ['kotlin'], 'swift': ['swift'], 'scala': ['scala'], 'r': ['r programming', 'rstudio', 'ggplot', 'ggplot2'],
        'matlab': ['matlab'], 'bash': ['bash', 'shell scripting', 'shell script'], 'sql': ['sql'],
        'html': ['html', 'html5'], 'css': ['css', 'css3', 'sass', 'scss'],
        // Web / frameworks
        'react': ['react', 'react.js', 'reactjs'], 'angular': ['angular', 'angularjs'], 'vue': ['vue', 'vue.js', 'vuejs'],
        'next.js': ['next.js', 'nextjs'], 'node.js': ['node.js', 'nodejs', 'node'], 'express': ['express', 'express.js', 'expressjs'],
        'django': ['django'], 'flask': ['flask'], 'fastapi': ['fastapi'], 'spring': ['spring', 'spring boot', 'spring mvc'],
        'tailwind': ['tailwind', 'tailwindcss'], 'bootstrap': ['bootstrap'], 'jquery': ['jquery'],
        'rest api': ['rest api', 'rest apis', 'restful', 'rest'], 'graphql': ['graphql'], 'microservices': ['microservices', 'microservice'],
        // Data / ML
        'machine learning': ['machine learning', 'ml'], 'deep learning': ['deep learning'], 'nlp': ['nlp', 'natural language processing'],
        'computer vision': ['computer vision', 'opencv'], 'tensorflow': ['tensorflow'], 'pytorch': ['pytorch'],
        'scikit-learn': ['scikit-learn', 'sklearn', 'scikit learn'], 'keras': ['keras'], 'pandas': ['pandas'], 'numpy': ['numpy'],
        'data analysis': ['data analysis', 'data analytics', 'data analyst'], 'data visualization': ['data visualization', 'data visualisation'],
        'statistics': ['statistics', 'statistical analysis', 'statistical'], 'etl': ['etl', 'data pipeline', 'data pipelines'],
        'data warehousing': ['data warehouse', 'data warehousing'], 'big data': ['big data', 'hadoop', 'spark', 'pyspark'],
        'generative ai': ['generative ai', 'genai', 'llm', 'llms', 'large language model', 'large language models'],
        'tableau': ['tableau'], 'power bi': ['power bi', 'powerbi'], 'excel': ['excel', 'ms excel', 'microsoft excel'],
        'a/b testing': ['a/b testing', 'a/b test', 'ab testing'],
        // Databases
        'mysql': ['mysql'], 'postgresql': ['postgresql', 'postgres'], 'mongodb': ['mongodb', 'mongo'], 'redis': ['redis'],
        'firebase': ['firebase'], 'nosql': ['nosql'], 'oracle': ['oracle'],
        // Cloud / devops
        'aws': ['aws', 'amazon web services'], 'azure': ['azure'], 'gcp': ['gcp', 'google cloud'], 'docker': ['docker'],
        'kubernetes': ['kubernetes', 'k8s'], 'git': ['git', 'github', 'gitlab'], 'ci/cd': ['ci/cd', 'cicd', 'jenkins', 'github actions'],
        'linux': ['linux', 'unix'], 'terraform': ['terraform'], 'devops': ['devops'],
        // Engineering practice
        'agile': ['agile', 'scrum', 'kanban'], 'sdlc': ['sdlc', 'software development life cycle', 'software development lifecycle'],
        'tdd': ['tdd', 'test-driven development', 'test driven development'], 'unit testing': ['unit testing', 'unit tests', 'junit', 'pytest', 'jest'],
        'data structures': ['data structures', 'dsa'], 'algorithms': ['algorithms', 'algorithm'], 'oop': ['oop', 'object-oriented', 'object oriented'],
        'system design': ['system design'], 'api': ['api', 'apis'], 'cybersecurity': ['cybersecurity', 'cyber security', 'information security'],
        // Marketing / business
        'seo': ['seo', 'search engine optimization'], 'sem': ['sem', 'ppc', 'google ads'], 'google analytics': ['google analytics'],
        'social media': ['social media'], 'content marketing': ['content marketing'], 'email marketing': ['email marketing'],
        'marketing automation': ['marketing automation', 'hubspot', 'marketo', 'mailchimp'], 'crm': ['crm', 'salesforce'],
        'brand management': ['brand management', 'branding', 'brand development'], 'campaign management': ['campaign management', 'campaigns'],
        'market research': ['market research'], 'budget management': ['budget management', 'budgeting', 'budgets'],
        'project management': ['project management', 'pmp', 'jira'], 'lead generation': ['lead generation'],
        'sales': ['sales'], 'figma': ['figma'], 'photoshop': ['photoshop'], 'ui/ux': ['ui/ux', 'ux design', 'ui design', 'ux'],
        // Soft skills
        'leadership': ['leadership', 'team lead', 'led a team'], 'communication': ['communication', 'communicator'],
        'teamwork': ['teamwork', 'team player', 'collaboration', 'collaborated', 'collaborative'],
        'problem solving': ['problem solving', 'problem-solving', 'troubleshooting'], 'presentation': ['presentation', 'presentations', 'presenting'],
        'negotiation': ['negotiation', 'negotiating'], 'stakeholder management': ['stakeholder', 'stakeholders']
    };

    const skillRegexCache = new Map();
    function aliasRegex(alias) {
        let re = skillRegexCache.get(alias);
        if (!re) {
            re = new RegExp('(^|[^a-z0-9+#])' + escapeRegex(alias) + '(?![a-z0-9+#])', 'g');
            skillRegexCache.set(alias, re);
        }
        re.lastIndex = 0;
        return re;
    }

    function normalise(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[\u2010-\u2015]/g, '-')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u00a0\t]+/g, ' ');
    }

    function findSkills(normText) {
        const found = new Map(); // canonical -> occurrence count
        for (const [canon, aliases] of Object.entries(SKILLS)) {
            let count = 0;
            for (const a of aliases) {
                const matches = normText.match(aliasRegex(a));
                if (matches) count += matches.length;
            }
            if (count) found.set(canon, count);
        }
        return found;
    }

    /* ----------------------------------------------------------------------
       Generic keyword extraction (for words that are not in the dictionary)
       ---------------------------------------------------------------------- */
    const STOP = new Set(('a an and are as at be been being by can could do does for from had has have he her his i if in into is it its may might must of on or our out she so some such than that the their them then there these they this those to too up us was we were what when where which while who will with would you your ' +
        'ability able about above across after all also am any another around based both but each etc few good great how including just like looking more most much need needs new not now only other over own per plus preferred required requirement requirements responsibilities responsibility role same should since strong strongly team teams through under until use used using via well within without work working works year years yrs candidate candidates job position company join ideal excellent proven proficiency proficient knowledge understanding familiarity familiar experience experienced skills skill including related relevant minimum least highly passionate seeking seek qualifications qualification duties apply applicant benefits location full time part salary opportunity opportunities bachelor bachelors master masters degree field equivalent various multiple key ' +
        'develop developing development design designing identify identifying define defining write writing ensure ensuring provide providing perform performing execute execution produce determine maintain maintaining deliver delivering create creating build building include install installing solution solutions user users system systems tool tools technology technologies document documents documenting documentation functionality specification specifications layout layouts plan plans planning gather gathering integrate integrating deploy deploying evaluate evaluating comply troubleshoot upgrade upgrading existing quality standard standards industry feedback procedure procedures component components methodology methodologies programming program programs language languages written verbal environment business needs level'
    ).split(/\s+/));

    let STOP_STEMS = null;
    function isStop(w) {
        if (!STOP_STEMS) STOP_STEMS = new Set([...STOP].map(stem));
        return STOP.has(w) || STOP_STEMS.has(stem(w));
    }

    function stem(w) {
        if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
        if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
        if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
        if (w.length > 5 && w.endsWith('es')) return w.slice(0, -2);
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
        return w;
    }

    /** text -> array of segments, each segment is an array of stems (stop-words removed) */
    function segments(normText, surfaceMap) {
        return normText
            .split(/[\n.,;:()\[\]|\/•●▪◦·–—!?]+| - /)
            .map((seg) => (seg.match(/[a-z][a-z0-9]{2,}/g) || [])
                .filter((w) => !isStop(w))
                .map((w) => { const st = stem(w); if (surfaceMap && !surfaceMap.has(st)) surfaceMap.set(st, w); return st; }))
            .filter((s) => s.length);
    }

    function maskSkills(normText) {
        let masked = normText;
        for (const aliases of Object.values(SKILLS)) {
            for (const a of aliases) masked = masked.replace(aliasRegex(a), ' ');
        }
        return masked;
    }

    /* ----------------------------------------------------------------------
       Job description profile (computed once per ranking run)
       ---------------------------------------------------------------------- */
    const REQ_CUES = /(require|must|proficien|experience (with|in)|knowledge of|familiar|expert|skilled|ability to|hands-on|proven)/;

    function buildJdProfile(jdText) {
        const norm = normalise(jdText);

        // 1) hard skills from the dictionary
        const skillCounts = findSkills(norm);
        const skills = [...skillCounts.entries()].map(([name, count]) => ({
            term: name, kind: 'skill', weight: 3 + (count >= 2 ? 1 : 0)
        }));

        // 2) generic terms (unigrams + bigrams) from the JD with skills masked out
        const masked = maskSkills(norm);
        const lines = masked.split('\n');
        const uni = new Map(); const bi = new Map();
        const surface = new Map(); // stem -> readable word
        for (const line of lines) {
            const inReq = REQ_CUES.test(line) ? 1 : 0;
            for (const seg of segments(line, surface)) {
                for (let i = 0; i < seg.length; i++) {
                    const w = seg[i];
                    if (w.length >= 4) {
                        const u = uni.get(w) || { n: 0, req: 0 };
                        u.n++; u.req = Math.max(u.req, inReq); uni.set(w, u);
                    }
                    if (i < seg.length - 1) {
                        const key = w + ' ' + seg[i + 1];
                        const b = bi.get(key) || { n: 0, req: 0 };
                        b.n++; b.req = Math.max(b.req, inReq); bi.set(key, b);
                    }
                }
            }
        }
        const candidates = [];
        uni.forEach((v, term) => {
            const score = v.n + v.req;
            if (v.n >= 2 || v.req) candidates.push({ term, kind: 'word', score });
        });
        bi.forEach((v, term) => {
            if (v.n >= 2) candidates.push({ term, kind: 'phrase', score: v.n * 1.5 + v.req });
        });
        candidates.sort((a, b) => b.score - a.score);

        // keep top 30; drop a unigram already covered by a kept phrase
        const generic = [];
        const phraseWords = new Set();
        candidates.filter((c) => c.kind === 'phrase').slice(0, 10).forEach((c) => c.term.split(' ').forEach((w) => phraseWords.add(w)));
        for (const c of candidates) {
            if (generic.length >= 30) break;
            if (c.kind === 'word' && phraseWords.has(c.term)) continue;
            const label = c.term.split(' ').map((w) => surface.get(w) || w).join(' ');
            generic.push({ term: c.term, label, kind: c.kind, weight: clamp(0.6 + c.score * 0.25, 0.8, 2.2) });
        }

        // 3) required years of experience
        let requiredYears = null;
        for (const line of norm.split('\n')) {
            if (!/experience|exp\b/.test(line) && !/years?|yrs?/.test(line)) continue;
            const m = line.match(/(\d{1,2})\s*\+?\s*(?:-|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?)/);
            if (m) { requiredYears = parseInt(m[1], 10); break; }
        }

        // 4) required education level
        const requiredEdu = educationLevel(norm, true);

        return { norm, skills, generic, requiredYears, requiredEdu };
    }

    /* ----------------------------------------------------------------------
       Resume scoring
       ---------------------------------------------------------------------- */
    const EDU_PATTERNS = [
        [4, ['phd', 'ph.d', 'doctorate', 'doctoral']],
        [3, ['master', 'masters', "master's", 'm.tech', 'mtech', 'm.e', 'msc', 'm.sc', 'mba', 'm.s', 'mca', 'postgraduate']],
        [2, ['bachelor', 'bachelors', "bachelor's", 'b.e', 'be', 'b.tech', 'btech', 'bsc', 'b.sc', 'bca', 'b.s', 'bs', 'ba', 'b.a', 'bba', 'undergraduate', 'degree']],
        [1, ['diploma', 'associate degree']]
    ];
    function educationLevel(norm, lowestMentioned) {
        const levels = [];
        for (const [level, words] of EDU_PATTERNS) {
            for (const w of words) {
                // short codes like "be"/"bs"/"ba" are too ambiguous in free text: require degree-like context
                if (w.length <= 2 && !new RegExp('(^|[^a-z])' + escapeRegex(w) + '[ ,.(]+(?:in|of)?\\s*(?:computer|information|engineering|science|arts|business|data|artificial|electronics)', 'i').test(norm)) continue;
                if (aliasRegex(w).test(norm)) { levels.push(level); break; }
            }
        }
        if (!levels.length) return 0;
        return lowestMentioned ? Math.min(...levels) : Math.max(...levels);
    }

    const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const EDU_LINE = /(b\.?e\b|b\.?tech|bachelor|master|m\.?tech|university|college|institute|school|cgpa|gpa|sslc|puc|degree|diploma|education|graduat|b\.?sc|m\.?sc|mba|class x|12th|10th)/;
    function estimateYears(rawText) {
        const norm = normalise(rawText);
        const now = new Date();
        const nowIdx = now.getFullYear() * 12 + now.getMonth();
        const intervals = [];
        const rangeRe = /(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+)?((?:19|20)\d{2})\s*(?:-|to|until)\s*(?:(present|current|now|ongoing|till date)|(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+)?((?:19|20)\d{2}))/g;
        for (const line of norm.split('\n')) {
            if (EDU_LINE.test(line)) continue;
            let m;
            rangeRe.lastIndex = 0;
            while ((m = rangeRe.exec(line))) {
                const sy = parseInt(m[2], 10);
                const sm = m[1] ? MONTHS[m[1]] : 0;
                let ey, em;
                if (m[3]) { ey = now.getFullYear(); em = now.getMonth(); }
                else { ey = parseInt(m[5], 10); em = m[4] ? MONTHS[m[4]] : 11; }
                const s = sy * 12 + sm; const e = Math.min(ey * 12 + em, nowIdx);
                if (e > s && e - s <= 12 * 40) intervals.push([s, e]);
            }
        }
        intervals.sort((a, b) => a[0] - b[0]);
        let months = 0; let cur = null;
        for (const iv of intervals) {
            if (!cur) cur = iv.slice();
            else if (iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
            else { months += cur[1] - cur[0]; cur = iv.slice(); }
        }
        if (cur) months += cur[1] - cur[0];
        let years = months / 12;

        // explicit statements such as "5+ years of experience"
        const explicit = [...norm.matchAll(/(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:[a-z ]{0,25})?experience/g)]
            .map((m) => parseFloat(m[1])).filter((n) => n > 0 && n <= 40);
        if (explicit.length) years = Math.max(years, Math.max(...explicit));
        return Math.round(years * 10) / 10;
    }

    const ACTION_VERBS = ['developed', 'built', 'designed', 'implemented', 'created', 'led', 'managed', 'launched', 'improved', 'optimized', 'optimised', 'increased', 'reduced', 'delivered', 'automated', 'deployed', 'analyzed', 'analysed', 'engineered', 'architected', 'coordinated', 'mentored', 'organized', 'organised', 'negotiated', 'secured', 'achieved', 'trained', 'integrated', 'migrated', 'collaborated', 'established', 'streamlined', 'generated', 'drove', 'owned', 'published', 'researched'];
    function impactScore(norm) {
        let verbs = 0;
        for (const v of ACTION_VERBS) if (aliasRegex(v).test(norm)) verbs++;
        const metrics = (norm.match(/\d+(?:\.\d+)?\s*%|\$\s?\d|\b\d+\s*\+\s|\b\d+x\b|\b\d{2,}[kmb]?\s+(?:users|customers|students|members|records|leads)/g) || []).length;
        const extras = (norm.match(/\b(project|projects|intern|internship|hackathon|publication|open[- ]source)\b/g) || []).length;
        return clamp(verbs * 6 + metrics * 5 + Math.min(15, extras * 3), 0, 100);
    }

    function guessName(text) {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6);
        for (const l of lines) {
            if (l.length > 40 || /[@\d:/]|http|resume|curriculum|vitae/i.test(l)) continue;
            const words = l.split(/\s+/);
            if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-z.'-]+$/.test(w))) {
                return l.replace(/\b([A-Za-z])([A-Za-z'-]*)\b/g, (m, a, b) => (m === m.toUpperCase() && m.length > 1 ? a + b.toLowerCase() : m));
            }
        }
        return '';
    }

    function scoreResume(text, jd) {
        const norm = normalise(text);

        // Hard skills
        const resumeSkills = findSkills(norm);
        const skillMatched = []; const skillMissing = [];
        let skillW = 0; let skillWMatched = 0;
        for (const s of jd.skills) {
            skillW += s.weight;
            if (resumeSkills.has(s.term)) { skillWMatched += s.weight; skillMatched.push(s.term); }
            else skillMissing.push(s.term);
        }

        // Generic keywords
        const resumeSegs = segments(norm);
        const uniSet = new Set(); const biSet = new Set();
        for (const seg of resumeSegs) {
            for (let i = 0; i < seg.length; i++) {
                uniSet.add(seg[i]);
                if (i < seg.length - 1) biSet.add(seg[i] + ' ' + seg[i + 1]);
            }
        }
        const genMatched = []; const genMissing = [];
        let genW = 0; let genWMatched = 0;
        for (const g of jd.generic) {
            genW += g.weight;
            const hit = g.kind === 'phrase'
                ? (biSet.has(g.term) || g.term.split(' ').every((w) => uniSet.has(w)) && 0.6)
                : uniSet.has(g.term);
            if (hit) { genWMatched += g.weight * (hit === true ? 1 : hit); genMatched.push(g.label || g.term); }
            else genMissing.push(g.label || g.term);
        }

        const totalW = skillW + genW;
        const keywordCoverage = totalW > 0 ? (skillWMatched + genWMatched) / totalW : 0;
        const skillsCoverage = skillW > 0 ? skillWMatched / skillW : null;

        // Experience
        const years = estimateYears(text);
        const impact = impactScore(norm);
        let experience;
        if (jd.requiredYears) {
            experience = 0.7 * clamp(years / jd.requiredYears, 0, 1) * 100 + 0.3 * impact;
        } else {
            experience = 0.3 * clamp(years / 3, 0, 1) * 100 + 0.7 * impact;
        }

        // ATS / formatting (reuses the same check as single-resume mode)
        const ats = typeof calculateATSScore === 'function' ? calculateATSScore(text) : 80;

        // Education
        const resumeEdu = educationLevel(norm, false);
        let education = null;
        if (jd.requiredEdu) {
            education = resumeEdu >= jd.requiredEdu ? 100 : (resumeEdu > 0 ? 55 : 30);
        }

        // Weighted overall (components that don't apply are dropped and the rest re-normalised)
        const parts = [
            { w: 0.50, v: keywordCoverage * 100, on: totalW > 0 },
            { w: 0.25, v: (skillsCoverage || 0) * 100, on: skillsCoverage !== null },
            { w: 0.15, v: experience, on: true },
            { w: 0.05, v: ats, on: true },
            { w: 0.05, v: education || 0, on: education !== null }
        ].filter((p) => p.on);
        const wSum = parts.reduce((s, p) => s + p.w, 0);
        const overall = Math.round(parts.reduce((s, p) => s + p.w * p.v, 0) / wSum);

        const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];

        return {
            overall_score: clamp(overall, 0, 100),
            detailed_scores: {
                skills_match: Math.round((skillsCoverage !== null ? skillsCoverage : keywordCoverage) * 100),
                keyword_match: pct(keywordCoverage),
                experience: Math.round(clamp(experience, 0, 100)),
                ats_compatibility: Math.round(ats),
                education: education === null ? null : education
            },
            matched: [...skillMatched, ...genMatched],
            missing: [...skillMissing, ...genMissing],
            years,
            name: guessName(text),
            email
        };
    }

    function verdictFor(score) {
        if (score >= 70) return { label: 'Strong Match', cls: 'high' };
        if (score >= 45) return { label: 'Moderate Match', cls: 'medium' };
        return { label: 'Weak Match', cls: 'low' };
    }

    /* ----------------------------------------------------------------------
       File queue UI
       ---------------------------------------------------------------------- */
    function addFiles(fileList) {
        const incoming = Array.from(fileList || []);
        let skipped = [];
        for (const f of incoming) {
            if (!ALLOWED_EXT.includes(ext(f.name))) { skipped.push(`${f.name} (unsupported type)`); continue; }
            if (f.size > MAX_FILE_MB * 1024 * 1024) { skipped.push(`${f.name} (over ${MAX_FILE_MB} MB)`); continue; }
            if (state.files.some((x) => x.file.name === f.name && x.file.size === f.size && x.file.lastModified === f.lastModified)) continue;
            if (state.files.length >= MAX_FILES) { skipped.push(`${f.name} (limit of ${MAX_FILES} reached)`); continue; }
            state.files.push({ id: state.nextId++, file: f, text: null, status: 'queued', error: '' });
        }
        renderFileList();
        updateRankButton();
        showNotice(skipped.length ? 'Skipped: ' + skipped.join(', ') : '');
    }

    function showNotice(msg) {
        const el = $('batchNotice');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('hidden', !msg);
    }

    function statusLabel(item) {
        switch (item.status) {
            case 'reading': return '<span class="file-status processing">Reading...</span>';
            case 'ready': return '<span class="file-status complete">Ready</span>';
            case 'error': return '<span class="file-status error" title="' + esc(item.error) + '">Unreadable</span>';
            default: return '<span class="file-status queued">Queued</span>';
        }
    }

    function renderFileList() {
        const list = $('batchFileList');
        const head = $('batchQueueHead');
        if (!list) return;
        if (head) {
            head.classList.toggle('hidden', state.files.length === 0);
            const c = $('batchFileCount'); if (c) c.textContent = state.files.length;
        }
        list.innerHTML = state.files.map((it) => `
            <div class="batch-file-item" data-id="${it.id}">
                <i class="fas fa-file-alt"></i>
                <span>${esc(it.file.name)}</span>
                ${statusLabel(it)}
                <button class="batch-remove" data-remove="${it.id}" title="Remove" aria-label="Remove ${esc(it.file.name)}" ${state.busy ? 'disabled' : ''}>&times;</button>
            </div>`).join('');
    }

    function updateRankButton() {
        const btn = $('rankBtn');
        if (!btn) return;
        const jd = ($('batchJobDescription') || {}).value || '';
        const ok = jd.trim().length >= 20 && state.files.length > 0 && !state.busy;
        btn.disabled = !ok;
        const label = $('rankBtnLabel');
        if (label) label.textContent = state.files.length ? `Rank ${state.files.length} Resume${state.files.length > 1 ? 's' : ''}` : 'Rank Resumes';
        const clear = $('clearBatchBtn');
        if (clear) clear.disabled = state.busy || (!state.files.length && !state.results.length);
        const hint = $('rankHint');
        if (hint) {
            hint.textContent = !jd.trim() ? 'Add a job description to enable ranking.'
                : jd.trim().length < 20 ? 'The job description is too short to rank against.'
                : !state.files.length ? 'Upload at least one resume.' : '';
        }
    }

    function setProgress(done, total, text) {
        const wrap = $('batchProgress');
        if (!wrap) return;
        wrap.classList.toggle('hidden', total === 0);
        const fill = $('batchProgressFill');
        if (fill) fill.style.width = (total ? (done / total) * 100 : 0) + '%';
        const t = $('batchProgressText');
        if (t) t.textContent = text || '';
    }

    /* ----------------------------------------------------------------------
       Ranking run
       ---------------------------------------------------------------------- */
    async function runRanking() {
        if (state.busy) return;
        const jdText = ($('batchJobDescription') || {}).value || '';
        if (jdText.trim().length < 20 || !state.files.length) return;

        state.busy = true;
        updateRankButton();
        renderFileList();
        $('batchResults').innerHTML = '';

        // 1) read every file once (cached for re-ranking with a different JD)
        const total = state.files.length;
        let done = 0;
        for (const it of state.files) {
            if (it.status === 'ready' || it.status === 'error') { done++; continue; }
            it.status = 'reading';
            renderFileList();
            setProgress(done, total, `Reading ${done + 1} of ${total}: ${it.file.name}`);
            await nextFrame();
            try {
                const text = await extractText(it.file);
                if (!text || text.replace(/\s/g, '').length < 50) {
                    throw new Error('No readable text found (scanned image PDF?). Try a text-based PDF or DOCX.');
                }
                it.text = text; it.status = 'ready'; it.error = '';
            } catch (err) {
                console.warn('Could not read', it.file.name, err);
                it.status = 'error'; it.error = (err && err.message) || 'Could not read this file';
            }
            done++;
            renderFileList();
        }

        // 2) score + rank
        setProgress(total, total, 'Scoring and ranking...');
        await nextFrame();
        const jd = buildJdProfile(jdText);
        const ranked = [];
        state.failed = [];
        for (const it of state.files) {
            if (it.status !== 'ready') { state.failed.push({ filename: it.file.name, error: it.error }); continue; }
            try {
                const r = scoreResume(it.text, jd);
                ranked.push(Object.assign({ filename: it.file.name }, r, { verdict: verdictFor(r.overall_score) }));
            } catch (err) {
                console.error('Scoring failed', it.file.name, err);
                state.failed.push({ filename: it.file.name, error: 'Scoring failed' });
            }
        }
        ranked.sort((a, b) =>
            b.overall_score - a.overall_score ||
            b.detailed_scores.skills_match - a.detailed_scores.skills_match ||
            b.detailed_scores.keyword_match - a.detailed_scores.keyword_match ||
            a.filename.localeCompare(b.filename));
        ranked.forEach((r, i) => { r.rank = i + 1; });

        state.results = ranked;
        state.jdSignature = jdText;
        state.busy = false;
        setProgress(0, 0, '');
        renderFileList();
        updateRankButton();
        renderResults();
        const res = $('batchResults');
        if (res && res.scrollIntoView) res.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* ----------------------------------------------------------------------
       Results UI
       ---------------------------------------------------------------------- */
    function metric(label, value) {
        return `<div class="batch-mini"><span class="metric-label">${label}</span><span class="metric-value">${value == null ? 'N/A' : value + '%'}</span></div>`;
    }
    function chips(list, cls, max) {
        if (!list.length) return '<span class="batch-none">None</span>';
        const shown = list.slice(0, max).map((k) => `<span class="keyword-tag ${cls}">${esc(k)}</span>`).join('');
        return shown + (list.length > max ? `<span class="batch-more">+${list.length - max} more</span>` : '');
    }

    function renderResults() {
        const box = $('batchResults');
        if (!box) return;
        const r = state.results;
        if (!r.length && !state.failed.length) { box.innerHTML = ''; return; }

        const avg = r.length ? Math.round(r.reduce((s, x) => s + x.overall_score, 0) / r.length) : 0;
        const strong = r.filter((x) => x.overall_score >= 70).length;
        const top = r[0];

        const failedHtml = state.failed.length ? `
            <div class="batch-failed">
                <h5><i class="fas fa-exclamation-triangle"></i> ${state.failed.length} file${state.failed.length > 1 ? 's' : ''} could not be ranked</h5>
                <ul>${state.failed.map((f) => `<li><strong>${esc(f.filename)}</strong> &mdash; ${esc(f.error)}</li>`).join('')}</ul>
            </div>` : '';

        box.innerHTML = `
            <div class="batch-results-head">
                <h4>Ranking Complete - ${r.length} Resume${r.length === 1 ? '' : 's'} Ranked</h4>
                <div class="batch-results-actions">
                    <button class="btn btn--outline btn--sm" id="exportCsvBtn"><i class="fas fa-file-csv"></i> Export CSV</button>
                    <button class="btn btn--outline btn--sm" id="exportPdfBtn"><i class="fas fa-file-pdf"></i> Ranking PDF</button>
                </div>
            </div>
            <div class="batch-results-grid">
                ${r.map((x, i) => `
                <div class="batch-result-card ${x.rank <= 3 ? 'top-' + x.rank : ''}" data-index="${i}">
                    <div class="batch-result-header">
                        <span class="batch-rank rank-${x.rank <= 3 ? x.rank : 'n'}">#${x.rank}</span>
                        <div class="batch-who">
                            <span class="file-name">${esc(x.name || x.filename)}</span>
                            ${x.name ? `<span class="batch-file-sub">${esc(x.filename)}</span>` : ''}
                        </div>
                        <span class="batch-verdict ${x.verdict.cls}">${x.verdict.label}</span>
                        <span class="batch-score ${x.verdict.cls}">${x.overall_score}%</span>
                    </div>
                    <div class="batch-bar"><div class="batch-bar-fill ${x.verdict.cls}" style="width:${x.overall_score}%"></div></div>
                    <div class="batch-metrics-grid">
                        ${metric('Skills Match', x.detailed_scores.skills_match)}
                        ${metric('Keywords', x.detailed_scores.keyword_match)}
                        ${metric('Experience', x.detailed_scores.experience)}
                        ${metric('ATS Score', x.detailed_scores.ats_compatibility)}
                    </div>
                    <div class="batch-chip-row"><span class="batch-chip-label">Matched</span><div class="keyword-tags">${chips(x.matched, 'matched', 6)}</div></div>
                    <div class="batch-chip-row"><span class="batch-chip-label">Missing</span><div class="keyword-tags">${chips(x.missing, 'missing', 6)}</div></div>
                    <div class="batch-detail hidden" id="batchDetail${i}">
                        ${x.email ? `<div class="batch-metric"><span class="metric-label">Email</span><span class="metric-value">${esc(x.email)}</span></div>` : ''}
                        <div class="batch-metric"><span class="metric-label">Estimated experience</span><span class="metric-value">${x.years ? x.years + ' yrs' : 'Not detected'}</span></div>
                        <div class="batch-metric"><span class="metric-label">Education fit</span><span class="metric-value">${x.detailed_scores.education == null ? 'Not required by JD' : x.detailed_scores.education + '%'}</span></div>
                        <div class="batch-chip-row"><span class="batch-chip-label">All matched (${x.matched.length})</span><div class="keyword-tags">${chips(x.matched, 'matched', 200)}</div></div>
                        <div class="batch-chip-row"><span class="batch-chip-label">All missing (${x.missing.length})</span><div class="keyword-tags">${chips(x.missing, 'missing', 200)}</div></div>
                    </div>
                    <div class="batch-actions">
                        <button class="btn btn--sm btn--primary" data-action="details" data-index="${i}">View Details</button>
                        <button class="btn btn--sm btn--outline" data-action="report" data-index="${i}">Download Report</button>
                    </div>
                </div>`).join('')}
            </div>
            ${failedHtml}
            ${r.length ? `
            <div class="batch-summary">
                <h5>Summary Statistics</h5>
                <div class="summary-stats">
                    <div class="summary-stat"><span class="stat-value">${avg}%</span><span class="stat-label">Average Score</span></div>
                    <div class="summary-stat"><span class="stat-value">${strong}</span><span class="stat-label">Strong Matches</span></div>
                    <div class="summary-stat"><span class="stat-value">${top.overall_score}%</span><span class="stat-label">Top Score</span></div>
                    <div class="summary-stat"><span class="stat-value batch-top-name">${esc(top.name || top.filename)}</span><span class="stat-label">Top Candidate</span></div>
                </div>
            </div>` : ''}`;
    }

    /* ----------------------------------------------------------------------
       Exports
       ---------------------------------------------------------------------- */
    function csvCell(v) {
        let s = String(v == null ? '' : v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
        return '"' + s.replace(/"/g, '""') + '"';
    }
    function exportCsv() {
        if (!state.results.length) return;
        const head = ['Rank', 'File', 'Name', 'Email', 'Overall %', 'Verdict', 'Skills %', 'Keywords %', 'Experience %', 'ATS %', 'Est. Years', 'Matched', 'Missing'];
        const rows = state.results.map((r) => [
            r.rank, r.filename, r.name, r.email, r.overall_score, r.verdict.label,
            r.detailed_scores.skills_match, r.detailed_scores.keyword_match, r.detailed_scores.experience,
            r.detailed_scores.ats_compatibility, r.years, r.matched.join('; '), r.missing.join('; ')
        ]);
        const csv = '\ufeff' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
        download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'resume-ranking.csv');
    }

    function download(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function pdfHeader(doc, title) {
        doc.setFillColor(37, 99, 235);
        doc.rect(0, 0, 210, 25, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text(title, 20, 16);
        doc.setTextColor(0, 0, 0);
    }

    function downloadRankingPdf() {
        if (!state.results.length) return;
        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();
            pdfHeader(doc, 'Resume Ranking Report');
            doc.setFontSize(10); doc.setFont('helvetica', 'normal');
            doc.text(`Generated: ${new Date().toLocaleDateString()}   |   ${state.results.length} resumes ranked`, 20, 33);
            let y = 44;
            doc.setFont('helvetica', 'bold');
            doc.text('Rank', 20, y); doc.text('Candidate / File', 36, y); doc.text('Score', 128, y);
            doc.text('Skills', 146, y); doc.text('Exp.', 164, y); doc.text('ATS', 180, y);
            doc.setFont('helvetica', 'normal');
            y += 3; doc.line(20, y, 190, y); y += 7;
            for (const r of state.results) {
                if (y > 280) { doc.addPage(); y = 20; }
                doc.text('#' + r.rank, 20, y);
                doc.text(doc.splitTextToSize(r.name || r.filename, 88)[0], 36, y);
                doc.text(r.overall_score + '%', 128, y);
                doc.text(r.detailed_scores.skills_match + '%', 146, y);
                doc.text(r.detailed_scores.experience + '%', 164, y);
                doc.text(r.detailed_scores.ats_compatibility + '%', 180, y);
                y += 8;
            }
            doc.save('resume-ranking.pdf');
        } catch (err) {
            console.error('PDF export failed', err);
            exportCsv();
        }
    }

    function downloadCandidateReport(r) {
        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();
            pdfHeader(doc, 'Candidate Analysis Report');
            let y = 40;
            const line = (text, size, bold) => {
                doc.setFontSize(size); doc.setFont('helvetica', bold ? 'bold' : 'normal');
                const parts = doc.splitTextToSize(text, 170);
                for (const p of parts) { if (y > 280) { doc.addPage(); y = 20; } doc.text(p, 20, y); y += size * 0.5 + 2; }
            };
            line(r.name || r.filename, 14, true);
            if (r.name) line('File: ' + r.filename, 10);
            if (r.email) line('Email: ' + r.email, 10);
            y += 3;
            line(`Rank #${r.rank} of ${state.results.length}  -  Overall Match: ${r.overall_score}% (${r.verdict.label})`, 12, true);
            y += 2;
            line(`Skills Match: ${r.detailed_scores.skills_match}%`, 11);
            line(`Keyword Match: ${r.detailed_scores.keyword_match}%`, 11);
            line(`Experience: ${r.detailed_scores.experience}%  (est. ${r.years || 'n/a'} yrs)`, 11);
            line(`ATS Compatibility: ${r.detailed_scores.ats_compatibility}%`, 11);
            if (r.detailed_scores.education != null) line(`Education Fit: ${r.detailed_scores.education}%`, 11);
            y += 4;
            line('Matched keywords', 12, true);
            line(r.matched.join(', ') || 'None', 10);
            y += 3;
            line('Missing keywords', 12, true);
            line(r.missing.join(', ') || 'None', 10);
            y += 3;
            line(`Generated: ${new Date().toLocaleDateString()}`, 9);
            doc.save(`${r.filename.replace(/\.[^.]+$/, '')}-analysis-report.pdf`);
        } catch (err) {
            console.error('PDF generation error:', err);
            const txt = `Analysis Report - ${r.filename}\nRank: #${r.rank}\nScore: ${r.overall_score}%\nMatched: ${r.matched.join(', ')}\nMissing: ${r.missing.join(', ')}\n`;
            download(new Blob([txt], { type: 'text/plain' }), r.filename + '-report.txt');
        }
    }

    /* ----------------------------------------------------------------------
       Wiring
       ---------------------------------------------------------------------- */
    function clearAll() {
        if (state.busy) return;
        state.files = []; state.results = []; state.failed = [];
        renderFileList(); renderResults(); updateRankButton(); showNotice('');
    }

    function prefillJd() {
        const ta = $('batchJobDescription');
        if (ta && !ta.value.trim() && typeof currentJobDescription === 'string' && currentJobDescription.trim()) {
            ta.value = currentJobDescription;
            updateCount();
            updateRankButton();
        }
    }

    function updateCount() {
        const ta = $('batchJobDescription'); const c = $('batchCharCount');
        if (ta && c) c.textContent = ta.value.length;
    }

    function init() {
        const zone = $('batchUploadZone');
        const input = $('batchFiles');
        const ta = $('batchJobDescription');
        if (!zone || !input) return;

        zone.addEventListener('click', () => { if (!state.busy) input.click(); });
        input.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault(); zone.classList.remove('dragover');
            if (!state.busy) addFiles(e.dataTransfer.files);
        });

        if (ta) ta.addEventListener('input', () => { updateCount(); updateRankButton(); });

        document.querySelectorAll('[data-batch-jd]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sample = typeof sampleData !== 'undefined' && sampleData.sampleJobDescriptions[btn.dataset.batchJd];
                if (sample && ta) { ta.value = sample.content; updateCount(); updateRankButton(); }
            });
        });

        const list = $('batchFileList');
        if (list) list.addEventListener('click', (e) => {
            const b = e.target.closest('[data-remove]');
            if (!b || state.busy) return;
            const id = parseInt(b.dataset.remove, 10);
            state.files = state.files.filter((f) => f.id !== id);
            renderFileList(); updateRankButton();
        });

        const rankBtn = $('rankBtn'); if (rankBtn) rankBtn.addEventListener('click', runRanking);
        const clearBtn = $('clearBatchBtn'); if (clearBtn) clearBtn.addEventListener('click', clearAll);

        const results = $('batchResults');
        if (results) results.addEventListener('click', (e) => {
            if (e.target.closest('#exportCsvBtn')) return exportCsv();
            if (e.target.closest('#exportPdfBtn')) return downloadRankingPdf();
            const b = e.target.closest('[data-action]');
            if (!b) return;
            const i = parseInt(b.dataset.index, 10);
            if (b.dataset.action === 'details') {
                const d = $('batchDetail' + i);
                if (d) {
                    const open = d.classList.toggle('hidden') === false;
                    b.textContent = open ? 'Hide Details' : 'View Details';
                }
            } else if (b.dataset.action === 'report' && state.results[i]) {
                downloadCandidateReport(state.results[i]);
            }
        });

        document.querySelectorAll('.mode-tab[data-mode="batch"]').forEach((t) => t.addEventListener('click', prefillJd));
        updateRankButton();
    }

    window.initBatchRanker = init;
    // Exposed for quick manual testing in the console / unit checks
    window.__batchRanker = { buildJdProfile, scoreResume, verdictFor, estimateYears, findSkills };
})();
