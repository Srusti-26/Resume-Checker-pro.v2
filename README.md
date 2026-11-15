# Resume Checker

A browser-based resume checker. Score one resume against a job description, or **upload a whole batch of resumes and have them ranked from best to weakest fit**. Everything runs client-side, so it deploys as a plain static site on GitHub Pages and no resume ever leaves the user's machine.

## Features

- **Single resume analysis** - keyword gaps, ATS score, charts, editor, PDF export, interview prep.
- **Batch ranking** - paste one job description, upload many resumes (PDF, DOCX, DOC, TXT) in one go or in several rounds, then click **Rank Resumes**.
  - Ranked #1 to #N with an overall match %, verdict, and Skills / Keywords / Experience / ATS breakdown.
  - See which keywords each candidate matched and which are missing.
  - Change the job description and re-rank instantly (files are only read once).
  - Export the ranking as **CSV** or **PDF**, or download a per-candidate report.
  - Unreadable files (e.g. scanned image PDFs) are listed separately instead of silently scored.

## How the batch score works

| Component | Weight | What it measures |
|---|---|---|
| Keyword match | 50% | Weighted coverage of the job description's important terms and phrases |
| Skills match | 25% | Coverage of hard skills found in the JD (languages, tools, frameworks, etc.) |
| Experience | 15% | Years of experience vs. the JD's requirement, plus impact (action verbs, metrics, projects) |
| ATS formatting | 5% | Contact info, length, structure |
| Education | 5% | Degree level vs. the JD (only counted if the JD mentions one) |

Components that don't apply to a given JD are dropped and the rest are re-normalised. Ties are broken by skills match, then keyword match.

This is keyword-based screening - a fast shortlisting aid, not a hiring decision. Always review top candidates manually.

## Run locally

No build step. Serve the folder with any static server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this repo to GitHub (branch `main`).
2. In the repo go to **Settings -> Pages -> Build and deployment -> Source** and choose **GitHub Actions**.
3. The workflow in `.github/workflows/static.yml` publishes `index.html`, `app.js`, `batch.js` and `enhanced_styles.css` on every push to `main`.

Your site will be at `https://<username>.github.io/<repo>/`.

## Files

- `index.html` - page and styles
- `app.js` - single-resume analysis, editor, chatbot, interview prep
- `batch.js` - batch upload, scoring and ranking
- `enhanced_styles.css` - additional styles (including batch results)

The Python files (`app.py`, `backend*.py`) are an optional legacy backend and are **not** needed for the GitHub Pages deployment.
