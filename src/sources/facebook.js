import fs from 'node:fs';
import path from 'node:path';
import { looksWanted } from '../../public/shared/core.js';

const MAX_POSTS = Number(process.env.FB_MAX_POSTS || 1500);
const MAX_AGE_DAYS = Number(process.env.FB_MAX_AGE_DAYS || 14);

export class FacebookStore {
  constructor(file) {
    this.file = file;
    this.posts = new Map();
    this.lastImport = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const p of raw.posts || []) this.posts.set(p.id, p);
      this.lastImport = raw.lastImport || null;
    } catch {
      // brak pliku przy pierwszym starcie
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastImport: this.lastImport, posts: [...this.posts.values()] }));
    fs.renameSync(tmp, this.file);
  }

  prune() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
    for (const [id, p] of this.posts) if (Date.parse(p.firstSeen) < cutoff) this.posts.delete(id);
    if (this.posts.size > MAX_POSTS) {
      const sorted = [...this.posts.values()].sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
      this.posts = new Map(sorted.slice(0, MAX_POSTS).map((p) => [p.id, p]));
    }
  }

  import(rawPosts) {
    let added = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const raw of Array.isArray(rawPosts) ? rawPosts.slice(0, 300) : []) {
      const post = sanitize(raw);
      if (!post) continue;
      const existing = this.posts.get(post.id);
      if (existing) {
        this.posts.set(post.id, {
          ...existing,
          ...post,
          image: post.image || existing.image,
          description: post.description.length >= existing.description.length ? post.description : existing.description,
          firstSeen: existing.firstSeen,
          lastSeen: now,
        });
        updated++;
      } else {
        this.posts.set(post.id, { ...post, firstSeen: now, lastSeen: now });
        added++;
      }
    }
    this.lastImport = now;
    this.prune();
    this.save();
    return { added, updated, total: this.posts.size };
  }

  list() {
    return [...this.posts.values()]
      .sort((a, b) => Date.parse(b.postedAt || b.firstSeen) - Date.parse(a.postedAt || a.firstSeen))
      .map((p) => ({
        ...p,
        source: 'fb',
        price: 0,
        priceLabel: 'Za darmo',
        free: true,
        wanted: looksWanted(p.description.slice(0, 200)),
        createdAt: p.postedAt || p.firstSeen,
      }));
  }

  clear() {
    this.posts.clear();
    this.save();
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = str(raw.url, 500);
  if (!/^https:\/\/(www\.|m\.|web\.)?facebook\.com\//.test(url)) return null;
  const description = str(raw.text, 3000);
  if (!description && !raw.image) return null;
  const id = str(raw.id, 100) || url;
  const image = str(raw.image, 2000);
  const postedAt = raw.postedAt && !Number.isNaN(Date.parse(raw.postedAt)) ? new Date(raw.postedAt).toISOString() : null;
  const firstLine = description.split('\n').find((l) => l.trim()) || 'Post z grupy';
  return {
    id,
    url,
    title: firstLine.slice(0, 140),
    description,
    image: /^https:\/\//.test(image) ? image : null,
    group: str(raw.group, 200),
    groupUrl: /^https:\/\/(www\.)?facebook\.com\//.test(str(raw.groupUrl, 300)) ? str(raw.groupUrl, 300) : null,
    author: str(raw.author, 120),
    location: str(raw.group, 200),
    postedAt,
  };
}
