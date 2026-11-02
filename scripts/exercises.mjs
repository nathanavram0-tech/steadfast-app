// Builds public/exercises.json, a slim index of the public-domain Free Exercise DB
// (github.com/yuhonas/free-exercise-db, Unlicense). The app matches logged exercise
// names against it to show a photo of the movement. Images are loaded from the CDN
// at the pinned commit below, so nothing heavy lives in this repo.
// Usage: node scripts/exercises.mjs path/to/exercises.json
import { readFileSync, writeFileSync } from 'node:fs';
const src = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = src.filter(e => e.images && e.images.length).map(e => ({
  i: e.id, n: e.name, m: e.primaryMuscles || [], s: (e.secondaryMuscles || []).slice(0, 3), e: e.equipment || '',
  c: String((e.instructions || [])[0] || '').replace(/\s+/g, ' ').slice(0, 180),
}));
writeFileSync('public/exercises.json', JSON.stringify({ commit: 'f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5', list: out }));
console.log(out.length, 'exercises');
