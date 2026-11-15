// apps/api/server.ts
import { createServer } from "node:http";
import { BlockList, isIP } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { existsSync as existsSync5, readFileSync as readFileSync5, statSync } from "node:fs";
import { resolve as resolve3, join as join5, extname } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// packages/database/index.ts
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  chmodSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { resolve, join } from "node:path";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash
} from "node:crypto";

// packages/database/schema.ts
var authSql = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL DEFAULT 'admin', password TEXT NOT NULL, changed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset INTEGER NOT NULL);
`, studioSql = `${authSql}
CREATE TABLE IF NOT EXISTS templates (id TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, template_id TEXT NOT NULL, template_version TEXT NOT NULL, manifest TEXT NOT NULL, config TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', url TEXT, notes TEXT NOT NULL DEFAULT '', admin_login TEXT NOT NULL DEFAULT 'admin', admin_password_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL, steps TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
`, tenantSql = `${authSql}
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, template TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL, phone TEXT NOT NULL,
 service_id TEXT NOT NULL, service_name TEXT NOT NULL, parameters TEXT NOT NULL, services_snapshot TEXT, note TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, duration INTEGER NOT NULL,
 post INTEGER NOT NULL, price INTEGER NOT NULL, price_max INTEGER NOT NULL, actual INTEGER, status TEXT NOT NULL CHECK(status IN ('booked','arrived','working','completed','cancelled','no_show')),
 consent TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, telegram_chat TEXT, telegram_link_hash TEXT UNIQUE, telegram_expires INTEGER, reminder_queued INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS bookings_interval ON bookings(start,end,post) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS booking_history (id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), target TEXT NOT NULL, kind TEXT NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_updates (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_config (
 id INTEGER PRIMARY KEY CHECK(id=1), token_cipher BLOB NOT NULL, username TEXT NOT NULL,
 webhook_secret TEXT NOT NULL, owner_chat TEXT, owner_link_hash TEXT, owner_link_expires INTEGER,
 updated_at INTEGER NOT NULL
);
`;

// packages/config/schema.ts
import { z } from "zod";
import { IANAZone } from "luxon";
var text = (max = 200) => z.string().trim().max(max), slugSchema = z.string().regex(
  /^[a-z][a-z0-9-]{1,47}$/,
  "\u0422\u043E\u043B\u044C\u043A\u043E \u043B\u0430\u0442\u0438\u043D\u0441\u043A\u0438\u0435 \u0431\u0443\u043A\u0432\u044B, \u0446\u0438\u0444\u0440\u044B \u0438 \u0434\u0435\u0444\u0438\u0441\u044B (2\u201348 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432)"
), time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), rangeSchema = z.object({ start: time, end: time }).refine((v) => v.start < v.end, "\u041D\u0430\u0447\u0430\u043B\u043E \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u0440\u0430\u043D\u044C\u0448\u0435 \u043A\u043E\u043D\u0446\u0430"), serviceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,48}$/),
  name: text(120).min(2),
  description: text(400),
  category: text(60).default("\u041E\u0441\u043D\u043E\u0432\u043D\u044B\u0435"),
  duration: z.number().int().min(5).max(480),
  priceType: z.enum(["fixed", "range"]),
  price: z.number().int().min(0).max(1e7),
  priceMax: z.number().int().min(0).max(1e7).optional(),
  active: z.boolean(),
  parameters: z.array(
    z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
      label: text(80).min(1),
      options: z.array(
        z.object({
          value: text(60).min(1),
          label: text(80).min(1),
          surcharge: z.number().int().min(0).max(1e6)
        })
      ).min(1).max(30)
    })
  ).max(8)
}).refine(
  (s) => s.priceType !== "range" || s.priceMax !== void 0 && s.priceMax >= s.price,
  "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0432\u0435\u0440\u0445\u043D\u044E\u044E \u0433\u0440\u0430\u043D\u0438\u0446\u0443 \u0446\u0435\u043D\u044B"
), image = z.string().max(500).refine(
  (v) => v === "" || /^\/assets\/[\w./-]+$/.test(v) || /^\/uploads\/[a-z0-9-]+\/[a-f0-9]+\.(?:jpg|png|webp)$/.test(v),
  "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440"
), configSchema = z.object({
  name: text(100).min(2),
  specialization: z.enum(["tire", "auto", "mixed"]).default("tire"),
  tagline: text(140).min(3),
  description: text(700),
  city: text(80),
  address: text(250),
  phone: text(30),
  email: z.union([z.email(), z.literal("")]),
  telegram: z.string().regex(/^$|^[a-zA-Z][a-zA-Z0-9_]{4,31}$/),
  links: z.object({
    map: z.union([z.literal(""), z.url().startsWith("https://")]),
    vk: z.union([z.literal(""), z.url().startsWith("https://")]),
    whatsapp: z.string().regex(/^$|^\+?[0-9]{10,15}$/)
  }).default({ map: "", vk: "", whatsapp: "" }),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  font: z.enum(["system", "manrope"]),
  logo: image,
  heroImage: image,
  gallery: z.array(z.object({ src: image, caption: text(140) })).max(24),
  benefits: z.array(z.object({ title: text(100), text: text(300) })).max(8),
  reviews: z.array(z.object({ name: text(100), text: text(1e3), source: text(250) })).max(30),
  legal: z.object({
    operator: text(250),
    inn: z.string().regex(/^$|^\d{10}$|^\d{12}$/),
    email: z.union([z.email(), z.literal("")]),
    retentionDays: z.number().int().min(30).max(3650),
    privacyText: text(1e4)
  }),
  seo: z.object({ title: text(120), description: text(300) }),
  sections: z.array(
    z.object({
      id: z.enum([
        "hero",
        "services",
        "calculator",
        "booking",
        "benefits",
        "gallery",
        "reviews",
        "contacts"
      ]),
      visible: z.boolean()
    })
  ).max(8),
  services: z.array(serviceSchema).min(1).max(60),
  schedule: z.object({
    timezone: z.string().refine((v) => IANAZone.isValidZone(v), "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043E\u044F\u0441"),
    posts: z.number().int().min(1).max(20),
    capacity: z.number().int().min(1).max(20),
    step: z.number().int().min(5).max(120),
    buffer: z.number().int().min(0).max(120),
    horizon: z.number().int().min(1).max(180),
    leadMinutes: z.number().int().min(0).max(10080),
    week: z.record(z.string().regex(/^[1-7]$/), z.array(rangeSchema).max(4)),
    exceptions: z.array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        ranges: z.array(rangeSchema).max(4)
      })
    ).max(100),
    blocks: z.array(
      z.object({
        start: z.iso.datetime({ offset: !0 }),
        end: z.iso.datetime({ offset: !0 }),
        post: z.number().int().min(0).max(20),
        reason: text(200)
      }).refine(
        (v) => Date.parse(v.end) > Date.parse(v.start),
        "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B"
      )
    ).max(200)
  }),
  demo: z.boolean()
}).superRefine((v, ctx) => {
  for (let [key, values] of [
    ["sections", v.sections.map((s) => s.id)],
    ["services", v.services.map((s) => s.id)]
  ])
    new Set(values).size !== values.length && ctx.addIssue({
      code: "custom",
      path: [key],
      message: "\u0418\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440\u044B \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0443\u043D\u0438\u043A\u0430\u043B\u044C\u043D\u044B"
    });
  for (let ranges of [
    ...Object.values(v.schedule.week),
    ...v.schedule.exceptions.map((e) => e.ranges)
  ]) {
    let sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
    sorted.some((r, i) => i > 0 && r.start < sorted[i - 1].end) && ctx.addIssue({
      code: "custom",
      path: ["schedule"],
      message: "\u0420\u0430\u0431\u043E\u0447\u0438\u0435 \u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B\u044B \u043F\u0435\u0440\u0435\u0441\u0435\u043A\u0430\u044E\u0442\u0441\u044F"
    });
  }
  for (let s of v.services)
    new Set(s.parameters.map((p) => p.key)).size !== s.parameters.length && ctx.addIssue({
      code: "custom",
      path: ["services"],
      message: "\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B \u0443\u0441\u043B\u0443\u0433\u0438 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0443\u043D\u0438\u043A\u0430\u043B\u044C\u043D\u044B"
    });
}), statuses = [
  "booked",
  "arrived",
  "working",
  "completed",
  "cancelled",
  "no_show"
];
var serviceSelectionSchema = z.object({
  serviceId: text(48).min(1),
  parameters: z.record(z.string(), text(60))
}), serviceSelectionsSchema = z.array(serviceSelectionSchema).min(1).max(20), bookingSchema = z.object({
  services: serviceSelectionsSchema.optional(),
  serviceId: text(48).min(1).optional(),
  parameters: z.record(z.string(), text(60)).default({}),
  name: text(100).min(2, "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0438\u043C\u044F"),
  phone: text(30).min(10),
  note: text(1500).default(""),
  start: z.iso.datetime({ offset: !0 }),
  consent: z.literal(!0, {
    error: "\u041D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u043E \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0434\u0430\u043D\u043D\u044B\u0445"
  }),
  idempotencyKey: z.uuid(),
  website: z.literal("").default(""),
  startedAt: z.number().int()
}).refine(
  (data) => data.services !== void 0 || data.serviceId !== void 0,
  {
    message: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0441\u043B\u0443\u0433\u0443",
    path: ["services"]
  }
).transform((data) => ({
  ...data,
  services: data.services ?? [
    { serviceId: data.serviceId, parameters: data.parameters }
  ]
})), defaultConfig = {
  name: "\u041F\u0418\u0422\u041B\u0415\u0419\u041D",
  specialization: "tire",
  tagline: `\u041F\u0435\u0440\u0435\u043E\u0431\u0443\u0435\u043C.
\u0418 \u0432\u044B \u0441\u043D\u043E\u0432\u0430 \u0432 \u043F\u0443\u0442\u0438.`,
  description: "\u0428\u0438\u043D\u043E\u043C\u043E\u043D\u0442\u0430\u0436 \u0431\u0435\u0437 \u043B\u0438\u0448\u043D\u0438\u0445 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0439. \u0423\u0437\u043D\u0430\u0439\u0442\u0435 \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0438 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0434\u043E\u0431\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u2014 \u043C\u044B \u0431\u0443\u0434\u0435\u043C \u0433\u043E\u0442\u043E\u0432\u044B \u043A \u0432\u0430\u0448\u0435\u043C\u0443 \u043F\u0440\u0438\u0435\u0437\u0434\u0443.",
  city: "\u041C\u043E\u0441\u043A\u0432\u0430",
  address: "\u0443\u043B. \u041F\u0440\u0438\u043C\u0435\u0440\u043D\u0430\u044F, 12 \xB7 \u0434\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u043E\u043D\u043D\u044B\u0439 \u0430\u0434\u0440\u0435\u0441",
  phone: "+7 (999) 000-00-00",
  email: "",
  telegram: "",
  links: { map: "", vk: "", whatsapp: "" },
  accent: "#ff6b35",
  font: "manrope",
  logo: "",
  heroImage: "/assets/workshop.svg",
  gallery: [],
  benefits: [
    {
      title: "\u0417\u0430\u043F\u0438\u0441\u044C \u043A \u0442\u043E\u0447\u043D\u043E\u043C\u0443 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
      text: "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E\u0441\u0442\u044C \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u043F\u043E\u0441\u0442\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442\u0441\u044F \u043F\u0440\u0438 \u0437\u0430\u043F\u0438\u0441\u0438."
    },
    {
      title: "\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0434\u043E \u0432\u0438\u0437\u0438\u0442\u0430",
      text: "\u041F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u0440\u0430\u0441\u0447\u0451\u0442 \u043F\u043E \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u043C \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u0430\u043C."
    },
    {
      title: "\u0412\u0441\u0451 \u0432 \u043E\u0434\u043D\u043E\u043C \u043C\u0435\u0441\u0442\u0435",
      text: "\u0417\u0430\u043C\u0435\u043D\u0430 \u043A\u043E\u043B\u0451\u0441, \u0431\u0430\u043B\u0430\u043D\u0441\u0438\u0440\u043E\u0432\u043A\u0430 \u0438 \u0440\u0435\u043C\u043E\u043D\u0442 \u0448\u0438\u043D."
    }
  ],
  reviews: [],
  legal: {
    operator: "\u0414\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u043E\u043D\u043D\u0430\u044F \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u0430\u044F",
    inn: "",
    email: "",
    retentionDays: 365,
    privacyText: ""
  },
  seo: {
    title: "\u041F\u0418\u0422\u041B\u0415\u0419\u041D \u2014 \u0448\u0438\u043D\u043E\u043C\u043E\u043D\u0442\u0430\u0436 \u0441 \u043E\u043D\u043B\u0430\u0439\u043D-\u0437\u0430\u043F\u0438\u0441\u044C\u044E",
    description: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0441\u043B\u0443\u0433\u0443, \u0443\u0437\u043D\u0430\u0439\u0442\u0435 \u043F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u0443\u044E \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0438 \u0437\u0430\u043F\u0438\u0448\u0438\u0442\u0435\u0441\u044C \u043A \u0443\u0434\u043E\u0431\u043D\u043E\u043C\u0443 \u0432\u0440\u0435\u043C\u0435\u043D\u0438."
  },
  sections: [
    "hero",
    "services",
    "calculator",
    "booking",
    "benefits",
    "gallery",
    "reviews",
    "contacts"
  ].map((id) => ({
    id,
    visible: !0
  })),
  services: [
    {
      id: "change",
      name: "\u0421\u0435\u0437\u043E\u043D\u043D\u0430\u044F \u0441\u043C\u0435\u043D\u0430 \u043A\u043E\u043B\u0451\u0441",
      category: "\u0428\u0438\u043D\u043E\u043C\u043E\u043D\u0442\u0430\u0436",
      description: "\u0421\u043D\u044F\u0442\u0438\u0435, \u043C\u043E\u043D\u0442\u0430\u0436 \u0438 \u0431\u0430\u043B\u0430\u043D\u0441\u0438\u0440\u043E\u0432\u043A\u0430 \u0447\u0435\u0442\u044B\u0440\u0451\u0445 \u043A\u043E\u043B\u0451\u0441.",
      duration: 60,
      priceType: "fixed",
      price: 2400,
      active: !0,
      parameters: [
        {
          key: "diameter",
          label: "\u0414\u0438\u0430\u043C\u0435\u0442\u0440 \u043A\u043E\u043B\u0451\u0441",
          options: [
            { value: "r14-16", label: "R14\u2013R16", surcharge: 0 },
            { value: "r17-18", label: "R17\u2013R18", surcharge: 800 },
            { value: "r19-21", label: "R19\u2013R21", surcharge: 1600 }
          ]
        },
        {
          key: "car",
          label: "\u0412\u0430\u0448 \u0430\u0432\u0442\u043E\u043C\u043E\u0431\u0438\u043B\u044C",
          options: [
            { value: "sedan", label: "\u041B\u0435\u0433\u043A\u043E\u0432\u043E\u0439", surcharge: 0 },
            { value: "suv", label: "\u041A\u0440\u043E\u0441\u0441\u043E\u0432\u0435\u0440 / SUV", surcharge: 600 }
          ]
        }
      ]
    },
    {
      id: "balance",
      name: "\u0411\u0430\u043B\u0430\u043D\u0441\u0438\u0440\u043E\u0432\u043A\u0430 \u043A\u043E\u043B\u0451\u0441",
      category: "\u0428\u0438\u043D\u043E\u043C\u043E\u043D\u0442\u0430\u0436",
      description: "\u0423\u0441\u0442\u0440\u0430\u043D\u0438\u043C \u0432\u0438\u0431\u0440\u0430\u0446\u0438\u0438 \u0434\u043B\u044F \u043A\u043E\u043C\u0444\u043E\u0440\u0442\u043D\u043E\u0439 \u043F\u043E\u0435\u0437\u0434\u043A\u0438.",
      duration: 40,
      priceType: "fixed",
      price: 1200,
      active: !0,
      parameters: []
    },
    {
      id: "repair",
      name: "\u0420\u0435\u043C\u043E\u043D\u0442 \u043F\u0440\u043E\u043A\u043E\u043B\u0430",
      category: "\u0420\u0435\u043C\u043E\u043D\u0442",
      description: "\u0414\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0430 \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u044F \u0438 \u0440\u0435\u043C\u043E\u043D\u0442 \u0448\u0438\u043D\u044B.",
      duration: 30,
      priceType: "range",
      price: 600,
      priceMax: 1500,
      active: !0,
      parameters: []
    },
    {
      id: "pressure",
      name: "\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0434\u0430\u0432\u043B\u0435\u043D\u0438\u044F",
      category: "\u041E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u0435",
      description: "\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u043C \u0438 \u0441\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u0438\u0440\u0443\u0435\u043C \u0434\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0432 \u0448\u0438\u043D\u0430\u0445.",
      duration: 10,
      priceType: "fixed",
      price: 200,
      active: !0,
      parameters: []
    }
  ],
  schedule: {
    timezone: "Europe/Moscow",
    posts: 2,
    capacity: 2,
    step: 30,
    buffer: 0,
    horizon: 30,
    leadMinutes: 60,
    week: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7].map((d) => [
        String(d),
        [
          { start: "09:00", end: "13:00" },
          { start: "14:00", end: "20:00" }
        ]
      ])
    ),
    exceptions: [],
    blocks: []
  },
  demo: !0
};

// packages/templates/registry.ts
import { z as z2 } from "zod";
var manifestSchema = z2.object({
  id: z2.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
  name: z2.string().min(2).max(100),
  version: z2.string().regex(/^\d+\.\d+\.\d+$/),
  schemaVersion: z2.literal(1),
  category: z2.string().min(2).max(80),
  description: z2.string().max(500),
  renderer: z2.enum(["tire", "business"]),
  capabilities: z2.array(z2.enum(["booking", "gallery", "reviews"])).max(3),
  editableFields: z2.array(
    z2.enum([
      "name",
      "tagline",
      "description",
      "contacts",
      "services",
      "schedule",
      "branding",
      "sections",
      "legal",
      "seo"
    ])
  ).max(10),
  migrations: z2.array(z2.enum(["tenant-v1"])).min(1).max(1),
  defaults: configSchema
}).strict(), tireTemplate = manifestSchema.parse({
  id: "tire-workshop",
  name: "\u0428\u0438\u043D\u043E\u043C\u043E\u043D\u0442\u0430\u0436",
  version: "1.0.0",
  schemaVersion: 1,
  category: "\u0410\u0432\u0442\u043E\u0441\u0435\u0440\u0432\u0438\u0441",
  description: "\u0421\u0430\u0439\u0442 \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u043E\u0439 \u0441 \u0440\u0430\u0441\u0447\u0451\u0442\u043E\u043C \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u0438, \u043E\u043D\u043B\u0430\u0439\u043D-\u0437\u0430\u043F\u0438\u0441\u044C\u044E \u0438 \u043B\u0438\u0447\u043D\u043E\u0439 \u0430\u0434\u043C\u0438\u043D-\u043F\u0430\u043D\u0435\u043B\u044C\u044E.",
  renderer: "tire",
  capabilities: ["booking", "gallery", "reviews"],
  editableFields: [
    "name",
    "tagline",
    "description",
    "contacts",
    "services",
    "schedule",
    "branding",
    "sections",
    "legal",
    "seo"
  ],
  migrations: ["tenant-v1"],
  defaults: defaultConfig
}), businessTemplate = manifestSchema.parse({
  ...tireTemplate,
  id: "business-landing",
  name: "\u0411\u0438\u0437\u043D\u0435\u0441-\u043B\u0435\u043D\u0434\u0438\u043D\u0433",
  category: "\u0423\u0441\u043B\u0443\u0433\u0438",
  description: "\u0423\u043D\u0438\u0432\u0435\u0440\u0441\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0430\u0439\u0442 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0431\u0438\u0437\u043D\u0435\u0441\u0430. \u0422\u0435 \u0436\u0435 \u043D\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043C\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435, \u0434\u0440\u0443\u0433\u043E\u0439 \u043A\u043E\u043D\u0442\u0435\u043D\u0442.",
  renderer: "business",
  defaults: {
    ...defaultConfig,
    name: "\u0424\u041E\u0420\u041C\u0410",
    tagline: `\u0412\u0430\u0448\u0435 \u0434\u0435\u043B\u043E.
\u0412 \u0446\u0435\u043D\u0442\u0440\u0435 \u0432\u043D\u0438\u043C\u0430\u043D\u0438\u044F.`,
    description: "\u0420\u0430\u0441\u0441\u043A\u0430\u0436\u0438\u0442\u0435 \u043E \u0441\u0432\u043E\u0435\u0439 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438, \u0443\u0441\u043B\u0443\u0433\u0430\u0445 \u0438 \u043F\u043E\u0434\u0445\u043E\u0434\u0435 \u043A \u0440\u0430\u0431\u043E\u0442\u0435.",
    heroImage: "/assets/business.svg",
    services: [
      {
        id: "consultation",
        name: "\u041A\u043E\u043D\u0441\u0443\u043B\u044C\u0442\u0430\u0446\u0438\u044F",
        description: "\u041E\u0431\u0441\u0443\u0434\u0438\u043C \u0432\u0430\u0448\u0443 \u0437\u0430\u0434\u0430\u0447\u0443 \u0438 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u043C \u0440\u0435\u0448\u0435\u043D\u0438\u0435.",
        category: "\u0423\u0441\u043B\u0443\u0433\u0438",
        duration: 30,
        priceType: "fixed",
        price: 1500,
        active: !0,
        parameters: []
      }
    ],
    benefits: [],
    seo: {
      title: "\u0424\u041E\u0420\u041C\u0410 \u2014 \u0443\u0441\u043B\u0443\u0433\u0438 \u0434\u043B\u044F \u0432\u0430\u0441",
      description: "\u0418\u043D\u0434\u0438\u0432\u0438\u0434\u0443\u0430\u043B\u044C\u043D\u044B\u0439 \u043F\u043E\u0434\u0445\u043E\u0434 \u0438 \u0443\u0434\u043E\u0431\u043D\u0430\u044F \u043E\u043D\u043B\u0430\u0439\u043D-\u0437\u0430\u043F\u0438\u0441\u044C."
    }
  }
});

// packages/database/index.ts
var hash = (value) => createHash("sha256").update(value).digest("hex"), secret = () => randomBytes(32).toString("base64url");
function passwordHash(password) {
  let salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function passwordCheck(password, stored) {
  let [salt, key] = stored.split(":");
  if (!salt || !key) return !1;
  let found = scryptSync(password, salt, 64), expected = Buffer.from(key, "hex");
  return found.length === expected.length && timingSafeEqual(found, expected);
}
function openDB(file, schema) {
  let db = new DatabaseSync(file);
  return db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"
  ), db.exec(schema), file !== ":memory:" && chmodSync(file, 384), db;
}
function addColumn(db, table, name, definition) {
  db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name) || db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
function migrateAuth(db, defaultUsername) {
  addColumn(db, "users", "username", `TEXT NOT NULL DEFAULT '${defaultUsername}'`);
}
function migrateStudio(db) {
  migrateAuth(db, "owner"), addColumn(db, "projects", "admin_login", "TEXT NOT NULL DEFAULT 'admin'"), addColumn(db, "projects", "admin_password_hash", "TEXT");
}
function migrateTenant(db) {
  if (migrateAuth(db, "admin"), db.prepare("PRAGMA user_version").get().user_version > 2) throw new Error("Tenant database schema is newer than this application");
  transaction(db, () => {
    db.prepare("PRAGMA table_info(bookings)").all().some((column) => column.name === "services_snapshot") || db.exec("ALTER TABLE bookings ADD COLUMN services_snapshot TEXT"), db.prepare("PRAGMA table_info(notifications)").all().some((column) => column.name === "message") || db.exec("ALTER TABLE notifications ADD COLUMN message TEXT"), db.exec("PRAGMA user_version=2");
  });
}
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    let v = fn();
    return db.exec("COMMIT"), v;
  } catch (e) {
    throw db.exec("ROLLBACK"), e;
  }
}
function audit(db, action, entity, detail) {
  db.prepare(
    "INSERT INTO audit(action,entity,detail,created_at) VALUES(?,?,?,?)"
  ).run(action, entity, JSON.stringify(detail), Date.now());
}
function readConfig(db) {
  let row = db.prepare("SELECT * FROM settings WHERE id=1").get();
  if (!row) throw new Error("Site not initialized");
  return {
    ...row,
    config: configSchema.parse(JSON.parse(row.config)),
    template: JSON.parse(row.template)
  };
}
function setConfig(db, config) {
  db.prepare("UPDATE settings SET config=?,revision=revision+1 WHERE id=1").run(
    JSON.stringify(config)
  );
}
var Store = class {
  dir;
  studio;
  tenants = /* @__PURE__ */ new Map();
  constructor(dir, singleSite2 = !1) {
    if (this.dir = resolve(dir), mkdirSync(join(this.dir, "tenants"), { recursive: !0, mode: 448 }), mkdirSync(join(this.dir, "uploads"), { recursive: !0, mode: 448 }), this.studio = openDB(singleSite2 ? ":memory:" : join(this.dir, "studio.sqlite"), studioSql), migrateStudio(this.studio), !singleSite2)
      for (let t of [tireTemplate, businessTemplate])
        this.studio.prepare(
          "INSERT OR IGNORE INTO templates(id,version,manifest) VALUES(?,?,?)"
        ).run(t.id, t.version, JSON.stringify(t));
  }
  credentials(scope2, db, password) {
    if (db.prepare("SELECT id FROM users").get()) return;
    let generated = password || secret().slice(0, 24), username = scope2 === "studio" ? process.env.STUDIO_LOGIN ?? "owner" : process.env.ADMIN_LOGIN ?? "admin";
    db.prepare("INSERT INTO users(id,username,password,changed_at) VALUES(1,?,?,?)").run(
      username,
      passwordHash(generated),
      Date.now()
    );
    let file = join(this.dir, "access.json"), existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    existing[scope2] = { username, password: generated }, writeFileSync(file, JSON.stringify(existing, null, 2), { mode: 384 }), chmodSync(file, 384);
  }
  preparedCredentials(scope2, db, username, preparedHash) {
    if (!db.prepare("SELECT id FROM users").get()) {
      if (!/^[A-Za-z0-9._-]{3,64}$/.test(username) || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(preparedHash))
        throw new Error("Invalid prepared administrator credentials");
      db.prepare("INSERT INTO users(id,username,password,changed_at) VALUES(1,?,?,?)").run(
        username,
        preparedHash,
        Date.now()
      ), audit(db, "auth.provisioned", scope2, { username });
    }
  }
  tenant(id) {
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error("Invalid site id");
    if (this.tenants.has(id)) return this.tenants.get(id);
    let file = join(this.dir, "tenants", `${id}.sqlite`);
    if (!existsSync(file)) return;
    let db = openDB(file, tenantSql);
    return migrateTenant(db), this.tenants.set(id, db), db;
  }
  provision(id, config, template, prepared) {
    let db = this.tenant(id);
    return db || (db = openDB(join(this.dir, "tenants", `${id}.sqlite`), tenantSql), migrateTenant(db), this.tenants.set(id, db)), db.prepare("SELECT id FROM settings WHERE id=1").get() || (db.prepare("INSERT INTO settings(id,config,template) VALUES(1,?,?)").run(
      JSON.stringify(config),
      JSON.stringify(template)
    ), prepared ? this.preparedCredentials(id, db, prepared.username, prepared.passwordHash) : this.credentials(id, db, process.env.ADMIN_PASSWORD)), db;
  }
  close() {
    for (let db of this.tenants.values()) db.close();
    this.studio.close();
  }
};

// apps/api/seed.ts
import { DateTime as DateTime2 } from "luxon";
import { existsSync as existsSync2, readFileSync as readFileSync2, cpSync } from "node:fs";
import { join as join2 } from "node:path";

// packages/booking/index.ts
import { DateTime } from "luxon";
import { createHash as createHash2 } from "node:crypto";
import { z as z3 } from "zod";
var DomainError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
function normalizePhone(input) {
  let digits = input.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits[0] === "8" && (digits = "7" + digits.slice(1)), digits.length === 10 && (digits = "7" + digits), !/^7\d{10}$/.test(digits))
    throw new DomainError(400, "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0440\u043E\u0441\u0441\u0438\u0439\u0441\u043A\u0438\u0439 \u043D\u043E\u043C\u0435\u0440: +7 \u0438 10 \u0446\u0438\u0444\u0440");
  return "+" + digits;
}
function quoteServices(config, selections) {
  let validated = serviceSelectionsSchema.parse(selections);
  if (new Set(validated.map((selection) => selection.serviceId)).size !== validated.length)
    throw new DomainError(400, "\u0423\u0441\u043B\u0443\u0433\u0438 \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u044B \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0442\u044C\u0441\u044F");
  let services = validated.map(({ serviceId, parameters }) => {
    let service = config.services.find((s) => s.id === serviceId && s.active);
    if (!service) throw new DomainError(400, "\u0423\u0441\u043B\u0443\u0433\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
    if (Object.keys(parameters).some(
      (key) => !service.parameters.some((p) => p.key === key)
    ))
      throw new DomainError(400, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440 \u0443\u0441\u043B\u0443\u0433\u0438");
    let surcharge = 0, details = {};
    for (let field of service.parameters) {
      let option = field.options.find(
        (o) => o.value === parameters[field.key]
      );
      if (!option) throw new DomainError(400, `\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435: ${field.label}`);
      surcharge += option.surcharge, details[field.label] = option.label;
    }
    return {
      serviceId: service.id,
      serviceName: service.name,
      parameters,
      details,
      price: service.price + surcharge,
      priceMax: (service.priceType === "range" ? service.priceMax : service.price) + surcharge,
      duration: service.duration
    };
  });
  return {
    services,
    price: services.reduce((sum, service) => sum + service.price, 0),
    priceMax: services.reduce((sum, service) => sum + service.priceMax, 0),
    duration: services.reduce((sum, service) => sum + service.duration, 0)
  };
}
function rangesFor(config, date) {
  return config.schedule.exceptions.find((e) => e.date === date.toISODate())?.ranges ?? config.schedule.week[String(date.weekday)] ?? [];
}
function inHours(config, start, end) {
  let date = DateTime.fromMillis(start, { zone: config.schedule.timezone });
  return rangesFor(config, date).some((r) => {
    let a = DateTime.fromISO(`${date.toISODate()}T${r.start}`, {
      zone: config.schedule.timezone
    }), b = DateTime.fromISO(`${date.toISODate()}T${r.end}`, {
      zone: config.schedule.timezone
    });
    return start >= a.toMillis() && end <= b.toMillis();
  });
}
function availablePost(db, config, start, end, excludeId = 0) {
  let capacity = Math.min(config.schedule.posts, config.schedule.capacity), overlaps = db.prepare(
    "SELECT post FROM bookings WHERE start<? AND end>? AND status NOT IN ('cancelled','no_show') AND deleted_at IS NULL AND id<>?"
  ).all(end, start, excludeId);
  for (let post = 1; post <= capacity; post++)
    if (!config.schedule.blocks.some(
      (b) => (b.post === 0 || b.post === post) && Date.parse(b.start) < end && Date.parse(b.end) > start
    ) && !overlaps.some((b) => b.post === post)) return post;
  return null;
}
function slots(db, config, serviceId, date, now = Date.now(), excludeId = 0, durationOverride, totalServiceDuration) {
  let service = config.services.find((s) => s.id === serviceId && s.active);
  if (!service && durationOverride === void 0 && totalServiceDuration === void 0)
    throw new DomainError(400, "\u0423\u0441\u043B\u0443\u0433\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
  let day = DateTime.fromISO(date, { zone: config.schedule.timezone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day.isValid)
    throw new DomainError(400, "\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0434\u0430\u0442\u0430");
  let today = DateTime.fromMillis(now, {
    zone: config.schedule.timezone
  }).startOf("day");
  if (day < today || day >= today.plus({ days: config.schedule.horizon }))
    return [];
  let duration = durationOverride ?? (totalServiceDuration ?? service.duration) + config.schedule.buffer, result = [];
  for (let range of rangesFor(config, day)) {
    let begin = DateTime.fromISO(`${date}T${range.start}`, {
      zone: config.schedule.timezone
    }), finish = DateTime.fromISO(`${date}T${range.end}`, {
      zone: config.schedule.timezone
    });
    for (let t = begin.toMillis(); t + duration * 6e4 <= finish.toMillis(); t += config.schedule.step * 6e4) {
      if (t < now + config.schedule.leadMinutes * 6e4) continue;
      let post = availablePost(
        db,
        config,
        t,
        t + duration * 6e4,
        excludeId
      );
      if (post) {
        let local = DateTime.fromMillis(t, {
          zone: config.schedule.timezone
        });
        result.push({
          start: local.toISO(),
          label: local.toFormat("HH:mm"),
          post
        });
      }
    }
  }
  return result;
}
function notify(db, id, kind) {
  let now = Date.now();
  for (let target of ["owner", "client"])
    db.prepare(
      "INSERT INTO notifications(booking_id,target,kind,next_at,created_at) VALUES(?,?,?,?,?)"
    ).run(id, target, kind, now, now);
}
function publicBooking(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    service: row.service_name,
    serviceId: row.service_id,
    parameters: JSON.parse(row.parameters),
    services: row.services_snapshot ? JSON.parse(row.services_snapshot) : [
      {
        serviceId: row.service_id,
        serviceName: row.service_name,
        parameters: JSON.parse(row.parameters),
        details: JSON.parse(row.parameters),
        price: row.price,
        priceMax: row.price_max,
        duration: row.duration
      }
    ],
    note: row.note,
    start: new Date(row.start).toISOString(),
    end: new Date(row.end).toISOString(),
    duration: row.duration,
    post: row.post,
    price: row.price,
    priceMax: row.price_max,
    actual: row.actual,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    clientId: row.client_id
  };
}
function createBooking(db, input, options = {}) {
  let data = bookingSchema.parse(input), now = options.now ?? Date.now(), phone = normalizePhone(data.phone);
  if (!options.admin && (now - data.startedAt < 1500 || now - data.startedAt > 72e5))
    throw new DomainError(400, "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0444\u043E\u0440\u043C\u0443 \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0437\u0430\u043F\u0438\u0441\u044C");
  let { services: _services, ...legacyData } = data, fingerprintData = input.services === void 0 ? legacyData : data, fingerprint = createHash2("sha256").update(JSON.stringify({ ...fingerprintData, phone, startedAt: 0 })).digest("hex");
  return transaction(db, () => {
    let old = db.prepare("SELECT * FROM idempotency WHERE key=?").get(data.idempotencyKey);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new DomainError(
          409,
          "\u042D\u0442\u043E\u0442 \u0437\u0430\u043F\u0440\u043E\u0441 \u0443\u0436\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D. \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0444\u043E\u0440\u043C\u0443."
        );
      return JSON.parse(old.response);
    }
    let config = readConfig(db).config, calc = quoteServices(config, data.services), first = calc.services[0], start = Date.parse(data.start), date = DateTime.fromMillis(start, {
      zone: config.schedule.timezone
    }).toISODate(), slot = slots(
      db,
      config,
      first.serviceId,
      date,
      now,
      0,
      void 0,
      calc.duration
    ).find((s) => Date.parse(s.start) === start);
    if (!slot)
      throw new DomainError(
        409,
        "\u042D\u0442\u043E \u0432\u0440\u0435\u043C\u044F \u0443\u0436\u0435 \u0437\u0430\u043D\u044F\u0442\u043E \u0438\u043B\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E. \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0439 \u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B."
      );
    db.prepare(
      "INSERT INTO clients(name,phone,created_at) VALUES(?,?,?) ON CONFLICT(phone) DO NOTHING"
    ).run(data.name, phone, now);
    let client = db.prepare("SELECT id FROM clients WHERE phone=?").get(phone), token = secret(), linkToken = secret(), result = db.prepare(
      "INSERT INTO bookings(client_id,name,phone,service_id,service_name,parameters,services_snapshot,note,start,end,duration,post,price,price_max,status,consent,token_hash,telegram_link_hash,telegram_expires,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'booked',?,?,?,?,?)"
    ).run(
      client.id,
      data.name,
      phone,
      first.serviceId,
      calc.services.map((line) => line.serviceName).join(" + "),
      JSON.stringify(first.details),
      JSON.stringify(calc.services),
      data.note,
      start,
      start + (calc.duration + config.schedule.buffer) * 6e4,
      calc.duration,
      slot.post,
      calc.price,
      calc.priceMax,
      JSON.stringify({
        version: 1,
        operator: config.legal.operator,
        acceptedAt: now,
        source: options.admin ? "admin" : "website",
        purpose: "\u041E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0430 \u043E\u043D\u043B\u0430\u0439\u043D-\u0437\u0430\u043F\u0438\u0441\u0438",
        policy: hash(config.legal.privacyText),
        retentionDays: config.legal.retentionDays
      }),
      hash(token),
      hash(linkToken),
      now + 864e5,
      now
    ), id = Number(result.lastInsertRowid);
    db.prepare(
      "INSERT INTO booking_history(booking_id,action,detail,created_at) VALUES(?,?,?,?)"
    ).run(
      id,
      "created",
      JSON.stringify({ source: options.admin ? "admin" : "website" }),
      now
    ), notify(db, id, "created"), audit(db, "booking.created", String(id), { post: slot.post });
    let response = {
      ...publicBooking(
        db.prepare("SELECT * FROM bookings WHERE id=?").get(id)
      ),
      token,
      telegramToken: linkToken
    };
    return db.prepare(
      "INSERT INTO idempotency(key,fingerprint,response,created_at) VALUES(?,?,?,?)"
    ).run(data.idempotencyKey, fingerprint, JSON.stringify(response), now), response;
  });
}
var bookingPatchSchema = z3.object({
  status: z3.enum(statuses).optional(),
  start: z3.iso.datetime({ offset: !0 }).optional(),
  note: z3.string().trim().max(1500).optional(),
  actual: z3.number().int().min(0).max(1e7).nullable().optional(),
  name: z3.string().trim().min(2).max(100).optional(),
  phone: z3.string().max(30).optional(),
  services: serviceSelectionsSchema.optional(),
  serviceId: z3.string().max(48).optional(),
  parameters: z3.record(z3.string(), z3.string().max(60)).optional()
}).strict();
function updateBooking(db, id, input) {
  let patch = bookingPatchSchema.parse(input);
  return transaction(db, () => {
    let old = db.prepare("SELECT * FROM bookings WHERE id=? AND deleted_at IS NULL").get(id);
    if (!old) throw new DomainError(404, "\u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
    let config = readConfig(db).config, start = patch.start ? Date.parse(patch.start) : old.start, changingService = patch.services !== void 0 || patch.serviceId !== void 0 || patch.parameters !== void 0, calculation = changingService ? quoteServices(
      config,
      patch.services ?? [
        {
          serviceId: patch.serviceId ?? old.service_id,
          parameters: patch.parameters ?? {}
        }
      ]
    ) : null, duration = calculation?.duration ?? old.duration, end = start + (calculation ? duration + config.schedule.buffer : (old.end - old.start) / 6e4) * 6e4, status = patch.status ?? old.status, post = old.post;
    if ((start !== old.start || changingService || ["cancelled", "no_show"].includes(old.status) && !["cancelled", "no_show"].includes(status)) && !["cancelled", "no_show"].includes(status)) {
      let date = DateTime.fromMillis(start, {
        zone: config.schedule.timezone
      }).toISODate();
      if (!slots(
        db,
        config,
        calculation?.services[0].serviceId ?? old.service_id,
        date,
        Date.now(),
        id,
        (end - start) / 6e4
      ).some((s) => Date.parse(s.start) === start))
        throw new DomainError(409, "\u041D\u043E\u0432\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
      post = availablePost(db, config, start, end, id);
    }
    let phone = patch.phone ? normalizePhone(patch.phone) : old.phone, name = patch.name ?? old.name;
    db.prepare(
      "INSERT INTO clients(name,phone,created_at) VALUES(?,?,?) ON CONFLICT(phone) DO NOTHING"
    ).run(name, phone, Date.now());
    let client = db.prepare("SELECT id FROM clients WHERE phone=?").get(phone);
    return start !== old.start && db.prepare(
      "UPDATE notifications SET status='cancelled',error='\u0412\u0440\u0435\u043C\u044F \u0437\u0430\u043F\u0438\u0441\u0438 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u043E' WHERE booking_id=? AND kind='reminder' AND status IN ('pending','retry','sending','failed','unconfigured')"
    ).run(id), db.prepare(
      "UPDATE bookings SET client_id=?,name=?,phone=?,start=?,end=?,post=?,status=?,note=?,actual=?,reminder_queued=CASE WHEN start<>? THEN 0 ELSE reminder_queued END  ,service_id=?,service_name=?,parameters=?,duration=?,price=?,price_max=?,services_snapshot=? WHERE id=?"
    ).run(
      client.id,
      name,
      phone,
      start,
      end,
      post,
      status,
      patch.note ?? old.note,
      patch.actual === void 0 ? old.actual : patch.actual,
      start,
      calculation?.services[0].serviceId ?? old.service_id,
      calculation?.services.map((line) => line.serviceName).join(" + ") ?? old.service_name,
      calculation ? JSON.stringify(calculation.services[0].details) : old.parameters,
      duration,
      calculation?.price ?? old.price,
      calculation?.priceMax ?? old.price_max,
      calculation ? JSON.stringify(calculation.services) : old.services_snapshot,
      id
    ), db.prepare(
      "INSERT INTO booking_history(booking_id,action,detail,created_at) VALUES(?,?,?,?)"
    ).run(
      id,
      "updated",
      JSON.stringify({
        before: {
          start: old.start,
          status: old.status,
          actual: old.actual,
          serviceId: old.service_id,
          price: old.price,
          duration: old.duration
        },
        after: patch
      }),
      Date.now()
    ), audit(db, "booking.updated", String(id), patch), (start !== old.start || status !== old.status || changingService) && notify(db, id, status === "cancelled" ? "cancelled" : "changed"), publicBooking(
      db.prepare("SELECT * FROM bookings WHERE id=?").get(id)
    );
  });
}
function deleteBooking(db, id) {
  return transaction(db, () => {
    if (!db.prepare(
      "UPDATE bookings SET deleted_at=? WHERE id=? AND deleted_at IS NULL"
    ).run(Date.now(), id).changes) throw new DomainError(404, "\u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
    db.prepare(
      "INSERT INTO booking_history(booking_id,action,detail,created_at) VALUES(?,?,?,?)"
    ).run(id, "deleted", "{}", Date.now()), audit(db, "booking.deleted", String(id), {}), notify(db, id, "cancelled");
  });
}
function validateScheduleChange(db, config) {
  let rows2 = db.prepare(
    "SELECT * FROM bookings WHERE end>? AND deleted_at IS NULL AND status NOT IN ('cancelled','no_show')"
  ).all(Date.now());
  for (let b of rows2)
    if (b.post > Math.min(config.schedule.posts, config.schedule.capacity) || !inHours(config, b.start, b.end) || config.schedule.blocks.some(
      (v) => (v.post === 0 || v.post === b.post) && Date.parse(v.start) < b.end && Date.parse(v.end) > b.start
    ))
      throw new DomainError(
        409,
        `\u041D\u043E\u0432\u043E\u0435 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u0443\u0435\u0442 \u0441 \u0437\u0430\u043F\u0438\u0441\u044C\u044E \u2116${b.id}. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0438\u0442\u0435 \u0438\u043B\u0438 \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u0435 \u0435\u0451.`
      );
}

// apps/api/seed.ts
import { randomUUID } from "node:crypto";
function initialize(store2, {
  demoMode: demoMode2,
  singleSite: singleSite2,
  sourceDir: sourceDir2
}) {
  if (singleSite2) {
    let file = existsSync2(join2(sourceDir2, "deployment.json")) ? join2(sourceDir2, "deployment.json") : join2(sourceDir2, "deploy/deployment.json");
    if (!existsSync2(file))
      throw new Error(
        "Single-site mode requires deployment.json from project export"
      );
    let source = JSON.parse(readFileSync2(file, "utf8"));
    if (source.id !== singleSite2)
      throw new Error("SITE_ID does not match deployment.json");
    let db2 = store2.provision(
      singleSite2,
      configSchema.parse(source.config),
      manifestSchema.parse(source.manifest),
      source.credentials
    );
    existsSync2(join2(sourceDir2, "deploy/seed-uploads")) && !existsSync2(join2(store2.dir, "uploads", singleSite2)) && cpSync(
      join2(sourceDir2, "deploy/seed-uploads"),
      join2(store2.dir, "uploads"),
      { recursive: !0 }
    );
    return;
  }
  store2.credentials("studio", store2.studio, process.env.STUDIO_PASSWORD);
  let legacyProjects = store2.studio.prepare("SELECT id FROM projects WHERE status='local' AND admin_password_hash IS NULL").all();
  for (let project of legacyProjects) {
    let user = store2.tenant(project.id)?.prepare("SELECT username,password FROM users WHERE id=1").get();
    user && store2.studio.prepare("UPDATE projects SET admin_login=?,admin_password_hash=?,updated_at=? WHERE id=? AND admin_password_hash IS NULL").run(user.username, user.password, Date.now(), project.id);
  }
  if (!demoMode2 || store2.studio.prepare("SELECT id FROM projects WHERE id='demo'").get())
    return;
  let now = Date.now(), config = structuredClone(defaultConfig), db = store2.provision("demo", config, tireTemplate);
  store2.studio.prepare(
    "INSERT INTO projects(id,name,template_id,template_version,manifest,config,status,url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).run(
    "demo",
    config.name,
    tireTemplate.id,
    tireTemplate.version,
    JSON.stringify(tireTemplate),
    JSON.stringify(config),
    "local",
    "/s/demo",
    now,
    now
  );
  for (let [id, name, t] of [
    ["sever", "\u0428\u0438\u043D\u043D\u044B\u0439 \u0446\u0435\u043D\u0442\u0440 \u0421\u0435\u0432\u0435\u0440", tireTemplate],
    ["forma", "\u0421\u0442\u0443\u0434\u0438\u044F \u0424\u043E\u0440\u043C\u0430", businessTemplate]
  ]) {
    let cfg = { ...structuredClone(t.defaults), name };
    store2.studio.prepare(
      "INSERT INTO projects(id,name,template_id,template_version,manifest,config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    ).run(
      id,
      name,
      t.id,
      t.version,
      JSON.stringify(t),
      JSON.stringify(cfg),
      now,
      now
    );
  }
  [
    "\u0410\u043B\u0435\u043A\u0441\u0435\u0439 \u041C\u043E\u0440\u043E\u0437\u043E\u0432",
    "\u041C\u0430\u0440\u0438\u044F \u0421\u043E\u043A\u043E\u043B\u043E\u0432\u0430",
    "\u0414\u043C\u0438\u0442\u0440\u0438\u0439 \u0412\u043E\u043B\u043A\u043E\u0432",
    "\u0410\u043D\u043D\u0430 \u041B\u0435\u0431\u0435\u0434\u0435\u0432\u0430",
    "\u0421\u0435\u0440\u0433\u0435\u0439 \u041E\u0440\u043B\u043E\u0432",
    "\u0415\u043B\u0435\u043D\u0430 \u041D\u043E\u0432\u0438\u043A\u043E\u0432\u0430",
    "\u0418\u0432\u0430\u043D \u041A\u0443\u0437\u043D\u0435\u0446\u043E\u0432",
    "\u041E\u043B\u044C\u0433\u0430 \u0421\u043C\u0438\u0440\u043D\u043E\u0432\u0430"
  ].forEach((name, i) => {
    let service = config.services[i % config.services.length], day = DateTime2.now().setZone(config.schedule.timezone).plus({ days: Math.floor(i / 3) + 1 }).toISODate(), available = slots(db, config, service.id, day);
    if (!available.length) return;
    let slot = available[Math.min(i * 2, available.length - 1)];
    createBooking(
      db,
      {
        serviceId: service.id,
        parameters: Object.fromEntries(
          service.parameters.map((p) => [p.key, p.options[0].value])
        ),
        name,
        phone: `+7999000000${i}`,
        note: "\u0412\u044B\u043C\u044B\u0448\u043B\u0435\u043D\u043D\u0430\u044F \u0434\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u043E\u043D\u043D\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C",
        start: slot.start,
        consent: !0,
        idempotencyKey: randomUUID(),
        startedAt: now - 5e3
      },
      { admin: !0 }
    );
  });
}

// apps/api/app.ts
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z as z4, ZodError } from "zod";
import { DateTime as DateTime5 } from "luxon";
import {
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync4,
  writeFileSync as writeFileSync3
} from "node:fs";
import { join as join4, resolve as resolve2 } from "node:path";
import "archiver";

// packages/notifications/index.ts
import { timingSafeEqual as timingSafeEqual2, createCipheriv, createDecipheriv, randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2, chmodSync as chmodSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { DateTime as DateTime3 } from "luxon";
function telegramKey(dataDir) {
  let file = join3(dataDir, "telegram.key");
  existsSync3(file) || writeFileSync2(file, randomBytes2(32), { mode: 384 }), chmodSync2(file, 384);
  let key = readFileSync3(file);
  if (key.length !== 32) throw new Error("Invalid Telegram encryption key");
  return key;
}
function encryptToken(token, dataDir) {
  let iv = randomBytes2(12), cipher = createCipheriv("aes-256-gcm", telegramKey(dataDir), iv), encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
function decryptToken(value, dataDir) {
  let bytes = Buffer.from(value);
  if (bytes.length < 29) throw new Error("Invalid encrypted Telegram token");
  let decipher = createDecipheriv("aes-256-gcm", telegramKey(dataDir), bytes.subarray(0, 12));
  return decipher.setAuthTag(bytes.subarray(12, 28)), Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
function telegramSettings(id, db, dataDir) {
  let p = "TELEGRAM_" + id.replace(/-/g, "_").toUpperCase(), stored = db?.prepare("SELECT token_cipher,username,webhook_secret,owner_chat FROM telegram_config WHERE id=1").get();
  return stored && dataDir ? {
    token: decryptToken(stored.token_cipher, dataDir),
    ownerChat: stored.owner_chat ?? void 0,
    username: stored.username,
    webhookSecret: stored.webhook_secret,
    personalDataApproved: process.env.TG_PERSONAL_DATA_APPROVED === "true"
  } : {
    token: process.env[p + "_TOKEN"],
    ownerChat: process.env[p + "_OWNER_CHAT"],
    username: process.env[p + "_USERNAME"],
    webhookSecret: process.env[p + "_WEBHOOK_SECRET"],
    personalDataApproved: process.env.TG_PERSONAL_DATA_APPROVED === "true"
  };
}
function telegramError(result, fallback) {
  return String(result?.description || fallback).slice(0, 300);
}
function createOwnerLink(db) {
  let row = db.prepare("SELECT username FROM telegram_config WHERE id=1").get();
  if (!row) throw new DomainError(409, "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 Telegram-\u0431\u043E\u0442\u0430");
  let token = randomBytes2(32).toString("base64url");
  return db.prepare("UPDATE telegram_config SET owner_link_hash=?,owner_link_expires=?,updated_at=? WHERE id=1").run(hash(token), Date.now() + 1800 * 1e3, Date.now()), { ownerLink: `https://t.me/${row.username}?start=owner_${token}`, expiresAt: Date.now() + 1800 * 1e3 };
}
async function configureTelegram(db, dataDir, token, origin2, siteId, fetcher = fetch) {
  let clean = token.trim();
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,80}$/.test(clean))
    throw new DomainError(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0442\u043E\u043A\u0435\u043D Telegram-\u0431\u043E\u0442\u0430");
  let request = async (method, body) => {
    let response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${clean}/${method}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : void 0,
        body: body ? JSON.stringify(body) : void 0,
        signal: AbortSignal.timeout(1e4)
      });
    } catch {
      throw new DomainError(502, "Telegram API \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    }
    let result = await response.json();
    if (!response.ok || !result.ok) throw new DomainError(400, telegramError(result, "Telegram \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u043B \u0437\u0430\u043F\u0440\u043E\u0441"));
    return result.result;
  }, bot = await request("getMe");
  if (!bot?.is_bot || !bot.username) throw new DomainError(400, "\u0422\u043E\u043A\u0435\u043D \u043D\u0435 \u043F\u0440\u0438\u043D\u0430\u0434\u043B\u0435\u0436\u0438\u0442 Telegram-\u0431\u043E\u0442\u0443");
  let webhookSecret = randomBytes2(32).toString("base64url");
  return await request("setWebhook", {
    url: `${origin2}/api/s/${siteId}/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message"]
  }), db.prepare(`INSERT INTO telegram_config(id,token_cipher,username,webhook_secret,owner_chat,owner_link_hash,owner_link_expires,updated_at)
    VALUES(1,?,?,?,NULL,NULL,NULL,?)
    ON CONFLICT(id) DO UPDATE SET token_cipher=excluded.token_cipher,username=excluded.username,webhook_secret=excluded.webhook_secret,owner_chat=NULL,owner_link_hash=NULL,owner_link_expires=NULL,updated_at=excluded.updated_at`).run(encryptToken(clean, dataDir), bot.username, webhookSecret, Date.now()), audit(db, "telegram.configured", "bot", { username: bot.username }), { username: bot.username, configured: !0, ownerLinked: !1, ...createOwnerLink(db) };
}
function checkWebhookSecret(actual, expected) {
  return !expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) ? !1 : timingSafeEqual2(Buffer.from(actual), Buffer.from(expected));
}
function linkTelegram(db, update) {
  return transaction(db, () => {
    if (db.prepare("SELECT id FROM telegram_updates WHERE id=?").get(update.update_id))
      return { ok: !0 };
    let text2 = update.message?.text ?? "", chat = update.message?.chat, owner = text2.match(/^\/start(?:@\w+)? owner_([A-Za-z0-9_-]{43})$/);
    if (owner && chat?.type === "private") {
      if (!db.prepare("UPDATE telegram_config SET owner_chat=?,owner_link_hash=NULL,owner_link_expires=NULL,updated_at=? WHERE id=1 AND owner_link_hash=? AND owner_link_expires>?").run(String(chat.id), Date.now(), hash(owner[1]), Date.now()).changes) throw new DomainError(400, "\u0421\u0441\u044B\u043B\u043A\u0430 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u0430 \u0438\u043B\u0438 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430");
      return db.prepare("INSERT INTO telegram_updates(id,created_at) VALUES(?,?)").run(update.update_id, Date.now()), audit(db, "telegram.owner_linked", "owner", { chat: String(chat.id) }), { ok: !0, ownerLinked: !0 };
    }
    let match = text2.match(/^\/start(?:@\w+)? ([A-Za-z0-9_-]{43})$/);
    if (!match || chat?.type !== "private") return { ok: !0 };
    let row = db.prepare(
      "SELECT id FROM bookings WHERE telegram_link_hash=? AND telegram_expires>? AND deleted_at IS NULL"
    ).get(hash(match[1]), Date.now());
    if (!row) throw new DomainError(400, "\u0421\u0441\u044B\u043B\u043A\u0430 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u0430 \u0438\u043B\u0438 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430");
    return db.prepare(
      "UPDATE bookings SET telegram_chat=?,telegram_link_hash=NULL,telegram_expires=NULL WHERE id=?"
    ).run(String(chat.id), row.id), db.prepare(
      "INSERT INTO notifications(booking_id,target,kind,next_at,created_at) VALUES(?,?,?,?,?)"
    ).run(row.id, "client", "confirmed", Date.now(), Date.now()), db.prepare("INSERT INTO telegram_updates(id,created_at) VALUES(?,?)").run(
      update.update_id,
      Date.now()
    ), { ok: !0 };
  });
}
function enqueueReminders(db, now = Date.now()) {
  transaction(db, () => {
    let rows2 = db.prepare(
      "SELECT id FROM bookings WHERE start>? AND start<=? AND telegram_chat IS NOT NULL AND reminder_queued=0 AND deleted_at IS NULL AND status='booked'"
    ).all(now, now + 864e5);
    for (let b of rows2)
      db.prepare(
        "INSERT INTO notifications(booking_id,target,kind,next_at,created_at) VALUES(?,'client','reminder',?,?)"
      ).run(b.id, now, now), db.prepare("UPDATE bookings SET reminder_queued=1 WHERE id=?").run(b.id);
  });
}
function queueManualMessage(db, bookingId, text2) {
  if (!Number.isSafeInteger(bookingId) || bookingId < 1)
    throw new DomainError(400, "\u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
  let message = text2.trim();
  if (!message) throw new DomainError(400, "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F");
  if (message.length > 1e3)
    throw new DomainError(400, "\u0422\u0435\u043A\u0441\u0442 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u043D\u0435 \u0434\u043E\u043B\u0436\u0435\u043D \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0442\u044C 1000 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
  return transaction(db, () => {
    let booking = db.prepare("SELECT id,telegram_chat FROM bookings WHERE id=? AND deleted_at IS NULL").get(bookingId);
    if (!booking) throw new DomainError(404, "\u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
    if (!booking.telegram_chat)
      throw new DomainError(409, "\u041A\u043B\u0438\u0435\u043D\u0442 \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043B Telegram \u043A \u0437\u0430\u043F\u0438\u0441\u0438");
    let now = Date.now(), result = db.prepare(
      "INSERT INTO notifications(booking_id,target,kind,message,next_at,created_at) VALUES(?,'client','manual',?,?,?)"
    ).run(bookingId, message, now, now);
    return audit(db, "telegram.manual_queued", String(bookingId), { notificationId: Number(result.lastInsertRowid) }), { id: Number(result.lastInsertRowid), status: "pending" };
  });
}
async function deliver(db, settings, origin2, siteId, fetcher = fetch, now = Date.now()) {
  if (!settings.token) return { configured: !1, sent: 0 };
  let sent = 0;
  for (let i = 0; i < 20; i++) {
    let job = transaction(db, () => {
      let row = db.prepare(
        "SELECT * FROM notifications WHERE (status IN ('pending','retry') OR (status='sending' AND next_at<=?)) AND next_at<=? ORDER BY id LIMIT 1"
      ).get(now, now);
      return row && db.prepare(
        "UPDATE notifications SET status='sending',next_at=? WHERE id=?"
      ).run(now + 12e4, row.id), row;
    });
    if (!job) break;
    let booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(job.booking_id);
    if (!db.prepare("SELECT id FROM notifications WHERE id=? AND status='sending'").get(job.id))
      continue;
    let chat = job.target === "owner" ? settings.ownerChat : booking.telegram_chat;
    if (!chat) {
      db.prepare(
        "UPDATE notifications SET status=?,error=? WHERE id=? AND status='sending'"
      ).run(
        job.target === "owner" ? "unconfigured" : "skipped",
        job.target === "owner" ? "\u041D\u0435 \u0437\u0430\u0434\u0430\u043D chat ID \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430" : "\u041A\u043B\u0438\u0435\u043D\u0442 \u043D\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u043B Telegram",
        job.id
      );
      continue;
    }
    if (job.kind === "manual" && !job.message) {
      db.prepare("UPDATE notifications SET status='failed',error='\u041F\u0443\u0441\u0442\u043E\u0439 \u0442\u0435\u043A\u0441\u0442 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F' WHERE id=? AND status='sending'").run(job.id);
      continue;
    }
    let config = readConfig(db).config, headings = {
      created: "\u041D\u043E\u0432\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C",
      confirmed: "\u0412\u0430\u0448\u0430 \u0437\u0430\u043F\u0438\u0441\u044C",
      changed: "\u0417\u0430\u043F\u0438\u0441\u044C \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0430",
      cancelled: "\u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430",
      reminder: "\u041D\u0430\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0435 \u043E \u0437\u0430\u043F\u0438\u0441\u0438"
    }, message = job.kind === "manual" ? job.message : `${headings[job.kind] ?? "\u0417\u0430\u043F\u0438\u0441\u044C"} \u2116${booking.id}
${config.name}`;
    job.kind !== "manual" && (settings.personalDataApproved ? message += `
\u041A\u043B\u0438\u0435\u043D\u0442: ${booking.name}
\u0422\u0435\u043B\u0435\u0444\u043E\u043D: ${booking.phone}
\u0423\u0441\u043B\u0443\u0433\u0430: ${booking.service_name}
\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C: \u043F\u0440\u0438\u043C\u0435\u0440\u043D\u043E ${booking.price} \u20BD
\u0412\u0440\u0435\u043C\u044F: ${DateTime3.fromMillis(booking.start, { zone: config.schedule.timezone }).toFormat("dd.MM.yyyy HH:mm")}
${config.address}` : message += `
\u041F\u043E\u0434\u0440\u043E\u0431\u043D\u043E\u0441\u0442\u0438 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u043D\u0430 \u0441\u0430\u0439\u0442\u0435. \u041F\u0435\u0440\u0435\u0434\u0430\u0447\u0430 \u043A\u043E\u043D\u0442\u0430\u043A\u0442\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0432 Telegram \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u0430.`);
    let body = { chat_id: chat, text: message };
    job.target === "owner" && (body.reply_markup = {
      inline_keyboard: [
        [
          {
            text: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0432 \u0430\u0434\u043C\u0438\u043D-\u043F\u0430\u043D\u0435\u043B\u0438",
            url: `${origin2}/s/${siteId}/admin?booking=${booking.id}`
          }
        ]
      ]
    });
    try {
      let response = await fetcher(
        `https://api.telegram.org/bot${settings.token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(1e4)
        }
      ), result = await response.json();
      if (response.ok && result.ok)
        db.prepare(
          "UPDATE notifications SET status='sent',attempts=attempts+1,error=NULL WHERE id=? AND status='sending'"
        ).run(job.id).changes && sent++;
      else if (result.error_code === 403 && job.target === "client")
        transaction(db, () => {
          db.prepare(
            "UPDATE notifications SET status='blocked',attempts=attempts+1,error='\u0411\u043E\u0442 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D \u043A\u043B\u0438\u0435\u043D\u0442\u043E\u043C' WHERE id=? AND status='sending'"
          ).run(job.id).changes && db.prepare("UPDATE bookings SET telegram_chat=NULL WHERE id=?").run(
            booking.id
          );
        });
      else {
        let attempts = job.attempts + 1;
        db.prepare(
          "UPDATE notifications SET status=?,attempts=?,next_at=?,error=? WHERE id=? AND status='sending'"
        ).run(
          attempts >= 8 ? "failed" : "retry",
          attempts,
          now + Math.max(
            result.parameters?.retry_after ?? 0,
            Math.min(3600, 30 * 2 ** attempts)
          ) * 1e3,
          `Telegram HTTP ${response.status}`,
          job.id
        );
      }
    } catch {
      let attempts = job.attempts + 1;
      db.prepare(
        "UPDATE notifications SET status=?,attempts=?,next_at=?,error=? WHERE id=? AND status='sending'"
      ).run(
        attempts >= 8 ? "failed" : "retry",
        attempts,
        now + Math.min(3600, 30 * 2 ** attempts) * 1e3,
        "\u0421\u0435\u0442\u044C Telegram \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430",
        job.id
      );
    }
  }
  return { configured: !0, sent };
}

// packages/finance/index.ts
import { DateTime as DateTime4 } from "luxon";
function bounds(month, zone) {
  let match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match)
    throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043C\u0435\u0441\u044F\u0446");
  let year = Number(match[1]), monthNumber = Number(match[2]), start = DateTime4.fromObject({ year, month: monthNumber, day: 1 }, { zone }).startOf("day"), nextYear = monthNumber === 12 ? year + 1 : year, nextMonth = monthNumber === 12 ? 1 : monthNumber + 1, end = DateTime4.fromObject({ year: nextYear, month: nextMonth, day: 1 }, { zone }).startOf("day");
  if (!start.isValid || !end.isValid) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043C\u0435\u0441\u044F\u0446");
  return { start, end };
}
function rows(db, start, end) {
  return db.prepare(
    "SELECT id,name,service_name,start,price_max,actual,status FROM bookings WHERE deleted_at IS NULL AND start>=? AND start<? ORDER BY start DESC"
  ).all(start, end);
}
function actualRevenue(items) {
  return items.reduce(
    (sum, row) => sum + (row.status === "completed" && row.actual !== null ? row.actual : 0),
    0
  );
}
function financeReport(db, month, zone) {
  let period = bounds(month, zone), previousMonth = period.start.minus({ days: 2 }).toFormat("yyyy-MM"), previous = bounds(previousMonth, zone), currentRows = rows(db, period.start.toMillis(), period.end.toMillis()), previousRows = rows(db, previous.start.toMillis(), previous.end.toMillis()), paid = currentRows.filter(
    (row) => row.status === "completed" && row.actual !== null
  ), revenue = actualRevenue(currentRows), previousRevenue = actualRevenue(previousRows), changePercent = previousRevenue ? Math.round((revenue - previousRevenue) / previousRevenue * 1e3) / 10 : null, dayRevenue = /* @__PURE__ */ new Map(), serviceStats = /* @__PURE__ */ new Map(), weekdayStats = /* @__PURE__ */ new Map();
  for (let row of paid) {
    let date = DateTime4.fromMillis(row.start, { zone }), day = date.toISODate();
    dayRevenue.set(day, (dayRevenue.get(day) ?? 0) + row.actual);
    let service = serviceStats.get(row.service_name) ?? { revenue: 0, bookings: 0 };
    service.revenue += row.actual, service.bookings += 1, serviceStats.set(row.service_name, service);
    let weekdayName = date.setLocale("ru").toFormat("cccc"), weekday = weekdayStats.get(weekdayName) ?? { revenue: 0, bookings: 0 };
    weekday.revenue += row.actual, weekday.bookings += 1, weekdayStats.set(weekdayName, weekday);
  }
  let days = Array.from({ length: period.start.daysInMonth }, (_, index) => {
    let date = period.start.plus({ days: index }), key = date.toISODate();
    return { date: key, label: date.toFormat("d"), revenue: dayRevenue.get(key) ?? 0 };
  });
  return {
    period: {
      month,
      previousMonth,
      label: period.start.setLocale("ru").toFormat("LLLL yyyy").replace(/^./, (v) => v.toUpperCase())
    },
    summary: {
      revenue,
      previousRevenue,
      changePercent,
      paidBookings: paid.length,
      completedWithoutActual: currentRows.filter(
        (row) => row.status === "completed" && row.actual === null
      ).length,
      averageCheck: paid.length ? Math.round(revenue / paid.length) : 0,
      expectedRevenue: currentRows.reduce(
        (sum, row) => sum + (["booked", "arrived", "working"].includes(row.status) ? row.price_max : 0),
        0
      ),
      lostEstimate: currentRows.reduce(
        (sum, row) => sum + (["cancelled", "no_show"].includes(row.status) ? row.price_max : 0),
        0
      ),
      cancelled: currentRows.filter((row) => row.status === "cancelled").length,
      noShow: currentRows.filter((row) => row.status === "no_show").length
    },
    days,
    services: [...serviceStats.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name)),
    weekdays: [...weekdayStats.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name)),
    completed: paid.map((row) => ({
      id: row.id,
      name: row.name,
      service: row.service_name,
      start: row.start,
      actual: row.actual
    }))
  };
}

// apps/api/app.ts
function jsonBody(c, schema) {
  return c.req.json().then((v) => schema.parse(v)).catch((e) => {
    throw e instanceof ZodError ? e : new DomainError(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 JSON");
  });
}
function createApp(store2, options) {
  let app2 = new Hono(), telegramFor = (c) => telegramSettings(c.get("tenantId"), c.get("db"), store2.dir);
  app2.use("*", async (c, next) => {
    c.set("ip", c.env?.remoteAddress ?? "unknown"), await next();
  });
  let production2 = !!options.production, sourceDir2 = options.sourceDir ?? process.cwd();
  app2.use(
    "*",
    secureHeaders({
      referrerPolicy: "no-referrer",
      crossOriginResourcePolicy: "same-origin",
      xFrameOptions: "SAMEORIGIN",
      contentSecurityPolicy: production2 ? {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      } : void 0
    })
  ), app2.use(
    "/api/*",
    bodyLimit({
      maxSize: 6 * 1024 * 1024,
      onError: (c) => c.json({ error: "\u0424\u0430\u0439\u043B \u0438\u043B\u0438 \u0437\u0430\u043F\u0440\u043E\u0441 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439" }, 413)
    })
  ), app2.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    let origin2 = c.req.header("Origin");
    if (origin2 && origin2 !== options.origin)
      return c.json({ error: "\u041D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0439 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u0437\u0430\u043F\u0440\u043E\u0441\u0430" }, 403);
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("Sec-Fetch-Site") === "cross-site")
      return c.json({ error: "\u041C\u0435\u0436\u0441\u0430\u0439\u0442\u043E\u0432\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u0437\u0430\u043F\u0440\u0435\u0449\u0451\u043D" }, 403);
    await next();
  });
  function rate(db, key, limit, windowMs) {
    let now = Date.now();
    transaction(db, () => {
      db.prepare("DELETE FROM rate_limits WHERE reset<?").run(now);
      let row = db.prepare("SELECT hits,reset FROM rate_limits WHERE key=?").get(key);
      if (row && row.hits >= limit)
        throw new DomainError(429, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.");
      db.prepare(
        "INSERT INTO rate_limits(key,hits,reset) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1"
      ).run(key, now + windowMs);
    });
  }
  let scope2 = (db, name) => async (c, next) => {
    c.set("db", db), c.set("scope", name), await next();
  }, studioGuard = async (c, next) => {
    if (options.singleSite)
      return c.json(
        { error: "Template Studio \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0432 \u043A\u043B\u0438\u0435\u043D\u0442\u0441\u043A\u043E\u043C \u044D\u043A\u0437\u0435\u043C\u043F\u043B\u044F\u0440\u0435" },
        404
      );
    await next();
  };
  app2.use("/api/s/:site/*", async (c, next) => {
    let id = slugSchema.safeParse(c.req.param("site"));
    if (!id.success || options.singleSite && id.data !== options.singleSite)
      return c.json({ error: "\u0421\u0430\u0439\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" }, 404);
    let db = store2.tenant(id.data);
    if (!db) return c.json({ error: "\u0421\u0430\u0439\u0442 \u043D\u0435 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D" }, 404);
    c.set("db", db), c.set("scope", id.data), c.set("tenantId", id.data), await next();
  });
  function auth(c) {
    let token = getCookie(c, `pit_${c.get("scope")}`), session = token ? c.get("db").prepare("SELECT csrf,expires FROM sessions WHERE hash=?").get(hash(token)) : void 0;
    if (!session || session.expires < Date.now())
      throw new DomainError(401, "\u0412\u043E\u0439\u0434\u0438\u0442\u0435 \u0432 \u043F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F");
    if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("X-CSRF-Token") !== session.csrf)
      throw new DomainError(403, "\u0421\u0435\u0441\u0441\u0438\u044F \u0444\u043E\u0440\u043C\u044B \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430. \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443.");
    return c.set("csrf", session.csrf), session;
  }
  let protect = async (c, next) => {
    auth(c), await next();
  };
  for (let base of ["/api/s/:site/admin"])
    app2.post(base + "/login", async (c) => {
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        throw new DomainError(415, "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F JSON");
      rate(c.get("db"), `login:${c.get("ip") ?? "unknown"}`, 8, 9e5);
      let data = await jsonBody(
        c,
        z4.object({
          username: z4.string().trim().min(1).max(80),
          password: z4.string().min(1).max(200)
        })
      ), user = c.get("db").prepare("SELECT username,password FROM users WHERE id=1").get();
      if (!user || data.username !== user.username || !passwordCheck(data.password, user.password))
        throw new DomainError(401, "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043B\u043E\u0433\u0438\u043D \u0438\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C");
      let token = secret(), csrf2 = secret();
      return c.get("db").prepare("DELETE FROM sessions WHERE expires<?").run(Date.now()), c.get("db").prepare("INSERT INTO sessions(hash,csrf,expires) VALUES(?,?,?)").run(hash(token), csrf2, Date.now() + 432e5), setCookie(c, `pit_${c.get("scope")}`, token, {
        httpOnly: !0,
        secure: production2,
        sameSite: "Strict",
        path: "/",
        maxAge: 43200
      }), audit(c.get("db"), "auth.login", "owner", {}), c.json({ csrf: csrf2 });
    }), app2.get(base + "/session", (c) => {
      let session = auth(c);
      return c.json({ csrf: session.csrf, scope: c.get("scope") });
    }), app2.post(base + "/logout", protect, (c) => {
      let token = getCookie(c, `pit_${c.get("scope")}`);
      return token && c.get("db").prepare("DELETE FROM sessions WHERE hash=?").run(hash(token)), deleteCookie(c, `pit_${c.get("scope")}`, { path: "/" }), c.json({ ok: !0 });
    }), app2.post(base + "/password", protect, async (c) => {
      let p = await jsonBody(
        c,
        z4.object({
          current: z4.string().max(200),
          password: z4.string().min(12, "\u041D\u0435 \u043C\u0435\u043D\u0435\u0435 12 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432").max(200)
        })
      ), db = c.get("db"), user = db.prepare("SELECT password FROM users WHERE id=1").get();
      if (!passwordCheck(p.current, user.password))
        throw new DomainError(400, "\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u043F\u0430\u0440\u043E\u043B\u044C \u043D\u0435\u0432\u0435\u0440\u0435\u043D");
      return transaction(db, () => {
        db.prepare("UPDATE users SET password=?,changed_at=? WHERE id=1").run(
          passwordHash(p.password),
          Date.now()
        ), db.exec("DELETE FROM sessions"), audit(db, "auth.password", "owner", {});
      }), c.json({ ok: !0 });
    });
  app2.get(
    "/api/health",
    (c) => c.json({
      ok: !0,
      mode: options.singleSite ? "customer" : "studio",
      time: (/* @__PURE__ */ new Date()).toISOString()
    })
  ), app2.get("/api/s/:site/config", (c) => {
    let { config, template } = readConfig(c.get("db"));
    return c.json({
      config: { ...config, services: config.services.filter((s) => s.active) },
      template: { id: template.id, renderer: template.renderer },
      telegramAvailable: !!telegramFor(c).username
    });
  });
  function slotSelection(c, config) {
    let encoded = c.req.query("services"), legacy = c.req.query("service");
    if (encoded === void 0 && legacy === void 0) return null;
    let input = legacy === void 0 ? void 0 : [legacy];
    if (encoded !== void 0) {
      if (encoded.length > 1500)
        throw new DomainError(400, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u0443\u0441\u043B\u0443\u0433");
      try {
        input = JSON.parse(encoded);
      } catch {
        throw new DomainError(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A \u0443\u0441\u043B\u0443\u0433");
      }
    }
    let ids = z4.array(serviceSelectionSchema.shape.serviceId).min(1).max(20).parse(input);
    if (new Set(ids).size !== ids.length)
      throw new DomainError(400, "\u0423\u0441\u043B\u0443\u0433\u0438 \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u044B \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0442\u044C\u0441\u044F");
    let duration = ids.reduce((sum, id) => {
      let service = config.services.find((s) => s.id === id && s.active);
      if (!service) throw new DomainError(400, "\u0423\u0441\u043B\u0443\u0433\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
      return sum + service.duration;
    }, 0);
    return { ids, duration };
  }
  return app2.get("/api/s/:site/slots", (c) => {
    rate(c.get("db"), `slots:${c.get("ip") ?? "unknown"}`, 150, 6e4);
    let config = readConfig(c.get("db")).config, selected = slotSelection(c, config);
    if (!selected) throw new DomainError(400, "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0441\u043B\u0443\u0433\u0443");
    return c.json(
      slots(
        c.get("db"),
        config,
        selected.ids[0],
        c.req.query("date") ?? "",
        Date.now(),
        0,
        void 0,
        selected.duration
      )
    );
  }), app2.post("/api/s/:site/quote", async (c) => {
    let data = await jsonBody(
      c,
      z4.object({
        services: serviceSelectionsSchema.optional(),
        serviceId: serviceSelectionSchema.shape.serviceId.optional(),
        parameters: serviceSelectionSchema.shape.parameters.default({})
      }).refine(
        (data2) => data2.services !== void 0 || data2.serviceId !== void 0,
        { message: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0441\u043B\u0443\u0433\u0443" }
      )
    );
    return c.json(
      quoteServices(
        readConfig(c.get("db")).config,
        data.services ?? [
          { serviceId: data.serviceId, parameters: data.parameters }
        ]
      )
    );
  }), app2.post("/api/s/:site/bookings", async (c) => {
    rate(c.get("db"), `book:${c.get("ip") ?? "unknown"}`, 10, 36e5);
    let data = await c.req.json().catch(() => {
      throw new DomainError(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 JSON");
    }), result = createBooking(c.get("db"), data), settings = telegramFor(c);
    return c.json(
      {
        ...result,
        telegramUrl: settings.username ? `https://t.me/${settings.username}?start=${result.telegramToken}` : null
      },
      201
    );
  }), app2.post("/api/s/:site/confirmation", async (c) => {
    let { token } = await jsonBody(
      c,
      z4.object({ token: z4.string().length(43) })
    );
    rate(c.get("db"), `confirmation:${c.get("ip") ?? "unknown"}`, 50, 6e4);
    let row = c.get("db").prepare(
      "SELECT * FROM bookings WHERE token_hash=? AND deleted_at IS NULL"
    ).get(hash(token));
    if (!row) throw new DomainError(404, "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
    return c.json(publicBooking(row));
  }), app2.post("/api/s/:site/telegram/webhook", async (c) => {
    if (!checkWebhookSecret(
      c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "",
      telegramFor(c).webhookSecret
    ))
      throw new DomainError(403, "\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u043F\u043E\u0434\u043F\u0438\u0441\u044C");
    let update = await jsonBody(
      c,
      z4.object({
        update_id: z4.number().int(),
        message: z4.object({
          text: z4.string().max(4096).optional(),
          chat: z4.object({ id: z4.number().int(), type: z4.string() }).optional()
        }).optional()
      })
    );
    try {
      return c.json(linkTelegram(c.get("db"), update));
    } catch (e) {
      if (e instanceof DomainError && e.status === 400)
        return c.json({ ok: !0 });
      throw e;
    }
  }), app2.use("/api/s/:site/admin/*", async (c, next) => ["login", "session", "logout", "password"].includes(
    c.req.path.split("/").at(-1)
  ) ? next() : protect(c, next)), app2.get("/api/s/:site/admin/slots", (c) => {
    let db = c.get("db"), config = readConfig(db).config, b = db.prepare("SELECT * FROM bookings WHERE id=? AND deleted_at IS NULL").get(Number(c.req.query("booking")));
    if (!b) throw new DomainError(404, "\u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
    let selected = slotSelection(c, config);
    return c.json(
      slots(
        db,
        config,
        selected?.ids[0] ?? b.service_id,
        c.req.query("date") ?? "",
        Date.now(),
        b.id,
        selected ? void 0 : (b.end - b.start) / 6e4,
        selected?.duration
      )
    );
  }), app2.get("/api/s/:site/admin/data", (c) => {
    let db = c.get("db"), { config, revision } = readConfig(db), from = c.req.query("from"), to = c.req.query("to"), bookings = from && to && DateTime5.fromISO(from).isValid && DateTime5.fromISO(to).isValid ? db.prepare(
      "SELECT * FROM bookings WHERE deleted_at IS NULL AND start>=? AND start<? ORDER BY start DESC"
    ).all(
      DateTime5.fromISO(from, {
        zone: config.schedule.timezone
      }).toMillis(),
      DateTime5.fromISO(to, { zone: config.schedule.timezone }).plus({ days: 1 }).toMillis()
    ) : db.prepare(
      "SELECT * FROM bookings WHERE deleted_at IS NULL ORDER BY start DESC LIMIT 2000"
    ).all(), clients = db.prepare(
      "SELECT c.*,COUNT(b.id) AS visits,SUM(CASE WHEN b.status='completed' THEN b.actual ELSE 0 END) AS actual,MAX(b.start) AS last_visit FROM clients c LEFT JOIN bookings b ON b.client_id=c.id AND b.deleted_at IS NULL GROUP BY c.id ORDER BY c.created_at DESC LIMIT 2000"
    ).all(), notifications = db.prepare(
      "SELECT id,booking_id,target,kind,status,attempts,error,created_at FROM notifications ORDER BY id DESC LIMIT 50"
    ).all();
    return c.json({
      config,
      revision,
      bookings: bookings.map(publicBooking),
      clients,
      notifications,
      telegram: (() => {
        let settings = telegramFor(c);
        return {
          configured: !!settings.token,
          username: settings.username ?? null,
          ownerLinked: !!settings.ownerChat,
          personalDataApproved: settings.personalDataApproved
        };
      })()
    });
  }), app2.get("/api/s/:site/admin/finance", (c) => {
    let month = c.req.query("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new DomainError(400, "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043C\u0435\u0441\u044F\u0446 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 \u0413\u0413\u0413\u0413-\u041C\u041C");
    let db = c.get("db"), { config } = readConfig(db);
    return c.json(financeReport(db, month, config.schedule.timezone));
  }), app2.get("/api/s/:site/admin/bookings/:id", (c) => {
    let db = c.get("db"), b = db.prepare("SELECT * FROM bookings WHERE id=?").get(Number(c.req.param("id")));
    if (!b) throw new DomainError(404, "\u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
    return c.json({
      ...publicBooking(b),
      telegramLinked: !!b.telegram_chat,
      history: db.prepare(
        "SELECT * FROM booking_history WHERE booking_id=? ORDER BY id DESC"
      ).all(b.id)
    });
  }), app2.post("/api/s/:site/admin/bookings/:id/message", async (c) => {
    let data = await jsonBody(c, z4.object({ text: z4.string().min(1).max(1e3) }));
    return c.json(queueManualMessage(c.get("db"), Number(c.req.param("id")), data.text), 201);
  }), app2.post(
    "/api/s/:site/admin/bookings",
    async (c) => c.json(
      createBooking(c.get("db"), await c.req.json(), { admin: !0 }),
      201
    )
  ), app2.patch(
    "/api/s/:site/admin/bookings/:id",
    async (c) => c.json(
      updateBooking(c.get("db"), Number(c.req.param("id")), await c.req.json())
    )
  ), app2.delete("/api/s/:site/admin/bookings/:id", (c) => (deleteBooking(c.get("db"), Number(c.req.param("id"))), c.json({ ok: !0 }))), app2.get("/api/s/:site/admin/clients/:id", (c) => {
    let db = c.get("db"), client = db.prepare("SELECT * FROM clients WHERE id=?").get(Number(c.req.param("id")));
    if (!client) throw new DomainError(404, "\u041A\u043B\u0438\u0435\u043D\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    return c.json({
      ...client,
      bookings: db.prepare(
        "SELECT * FROM bookings WHERE client_id=? AND deleted_at IS NULL ORDER BY start DESC"
      ).all(Number(c.req.param("id"))).map(publicBooking)
    });
  }), app2.patch("/api/s/:site/admin/clients/:id", async (c) => {
    let data = await jsonBody(c, z4.object({ notes: z4.string().max(5e3) }));
    return c.get("db").prepare("UPDATE clients SET notes=? WHERE id=?").run(data.notes, Number(c.req.param("id"))), audit(c.get("db"), "client.notes", c.req.param("id"), {}), c.json({ ok: !0 });
  }), app2.put("/api/s/:site/admin/config", async (c) => {
    let data = await jsonBody(
      c,
      z4.object({ config: configSchema, revision: z4.number().int() })
    ), db = c.get("db");
    return transaction(db, () => {
      let old = readConfig(db);
      if (old.revision !== data.revision)
        throw new DomainError(409, "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u044B. \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443.");
      let allowed = {
        ...old.config,
        services: data.config.services,
        schedule: data.config.schedule
      };
      if (JSON.stringify(allowed) !== JSON.stringify(data.config))
        throw new DomainError(403, "\u0418\u0437\u043C\u0435\u043D\u044F\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435 \u0441\u0430\u0439\u0442\u0430 \u043C\u043E\u0436\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u0435\u0446 \u043A\u043E\u043D\u0432\u0435\u0439\u0435\u0440\u0430");
      validateScheduleChange(db, data.config), setConfig(db, allowed), audit(db, "settings.updated", "site", {});
    }), c.json({ ok: !0 });
  }), app2.post(
    "/api/s/:site/admin/upload",
    (c) => c.json({ error: "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u0444\u043E\u0442\u043E\u0433\u0440\u0430\u0444\u0438\u0439 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443 \u043A\u043E\u043D\u0432\u0435\u0439\u0435\u0440\u0430" }, 403)
  ), app2.get(
    "/api/s/:site/admin/audit",
    (c) => c.json(
      c.get("db").prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 200").all()
    )
  ), app2.post("/api/s/:site/admin/notifications/retry", (c) => (c.get("db").prepare(
    "UPDATE notifications SET status='pending',attempts=0,next_at=?,error=NULL WHERE status IN ('failed','unconfigured','retry')"
  ).run(Date.now()), c.json({ ok: !0 }))), app2.post("/api/s/:site/admin/telegram/connect", async (c) => {
    let data = await jsonBody(c, z4.object({ token: z4.string().trim().min(1).max(200) }));
    return c.json(
      await configureTelegram(
        c.get("db"),
        store2.dir,
        data.token,
        options.origin,
        c.get("tenantId"),
        options.fetcher ?? fetch
      )
    );
  }), app2.post(
    "/api/s/:site/admin/telegram/owner-link",
    (c) => c.json(createOwnerLink(c.get("db")))
  ), app2.get("/uploads/:site/:file", (c) => {
    let site = c.req.param("site"), file = c.req.param("file");
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(site) || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(file))
      throw new DomainError(404, "\u0424\u0430\u0439\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    let path = join4(store2.dir, "uploads", site, file);
    if (!existsSync4(path)) throw new DomainError(404, "\u0424\u0430\u0439\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    return c.header(
      "Content-Type",
      file.endsWith(".jpg") ? "image/jpeg" : file.endsWith(".png") ? "image/png" : "image/webp"
    ), c.header("Cache-Control", "public,max-age=31536000,immutable"), c.body(new Uint8Array(readFileSync4(path)));
  }), app2.get(
    "/s/:site/robots.txt",
    (c) => c.text(
      `User-agent: *
Allow: /s/${c.req.param("site")}
Disallow: /api/
Disallow: /studio
Disallow: /s/${c.req.param("site")}/admin
Sitemap: ${options.origin}/s/${c.req.param("site")}/sitemap.xml`
    )
  ), app2.get("/s/:site/sitemap.xml", (c) => {
    let id = slugSchema.parse(c.req.param("site"));
    if (!store2.tenant(id) || options.singleSite && options.singleSite !== id)
      throw new DomainError(404, "\u0421\u0430\u0439\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    return c.header("Content-Type", "application/xml"), c.body(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${options.origin.replaceAll("&", "&amp;")}/s/${id}</loc></url></urlset>`
    );
  }), app2.get(
    "/robots.txt",
    (c) => c.text(
      `User-agent: *
Disallow: /studio
Disallow: /api/
Disallow: /*/admin
${options.singleSite ? `Sitemap: ${options.origin}/s/${options.singleSite}/sitemap.xml` : ""}`
    )
  ), app2.onError((e, c) => e instanceof ZodError ? c.json(
    {
      error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" \xB7 "),
      issues: e.issues
    },
    400
  ) : e instanceof DomainError ? c.json({ error: e.message }, e.status) : (console.error(
    "Request failed:",
    e.name,
    e.message.replace(/bot[\w:-]+/g, "bot[redacted]")
  ), c.json(
    { error: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0437\u0430\u043F\u0440\u043E\u0441. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u0437\u0436\u0435." },
    500
  ))), app2;
}

// apps/web/src/site.tsx
import { useState as useState3, useEffect as useEffect3 } from "react";
import {
  ArrowRight as ArrowRight3,
  ArrowUpRight as ArrowUpRight2,
  Check as Check3,
  Clock3 as Clock32,
  MapPin as MapPin2,
  Phone as Phone2,
  Wrench,
  Disc3,
  ShieldCheck as ShieldCheck3,
  Navigation,
  Send as Send2
} from "lucide-react";

// packages/config/display.ts
var money = (n) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " \u20BD";
function priceLabel(min, max) {
  return max && max !== min ? `${money(min)} \u2013 ${money(max)}` : money(min);
}
var dateKey = (zone = "Europe/Moscow", date = /* @__PURE__ */ new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(date), shiftDay = (date, offset) => {
  let d = /* @__PURE__ */ new Date(date + "T12:00:00Z");
  return d.setUTCDate(d.getUTCDate() + offset), d.toISOString().slice(0, 10);
}, formatTime = (date, zone = "Europe/Moscow") => new Date(date).toLocaleTimeString("ru-RU", {
  timeZone: zone,
  hour: "2-digit",
  minute: "2-digit"
}), formatDate = (date, zone = "Europe/Moscow") => new Date(date.length === 10 ? date + "T12:00:00Z" : date).toLocaleDateString(
  "ru-RU",
  { timeZone: zone, day: "numeric", month: "long" }
);

// apps/web/src/api.ts
var csrf = /* @__PURE__ */ new Map();
function scope(url2) {
  return url2.startsWith("/api/studio") ? "/api/studio" : url2.match(/^\/api\/s\/[^/]+\/admin/)?.[0] ?? "";
}
var APIError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
  status;
};
async function api(url2, options = {}) {
  let headers = new Headers(options.headers);
  options.body && !(options.body instanceof FormData) && headers.set("Content-Type", "application/json");
  let key = scope(url2);
  csrf.has(key) && headers.set("X-CSRF-Token", csrf.get(key));
  let res = await fetch(url2, {
    ...options,
    headers,
    credentials: "same-origin"
  }), body;
  try {
    body = await res.json();
  } catch {
    throw new APIError("\u0421\u0435\u0440\u0432\u0435\u0440 \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435\u043E\u0436\u0438\u0434\u0430\u043D\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442", res.status);
  }
  if (!res.ok)
    throw new APIError(body.error ?? "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0437\u0430\u043F\u0440\u043E\u0441", res.status);
  return body.csrf && csrf.set(key, body.csrf), body;
}
var send = (url2, data, method = "POST") => api(url2, { method, body: JSON.stringify(data) });

// apps/web/src/booking.tsx
import { useState as useState2, useEffect as useEffect2, useRef as useRef2 } from "react";
import {
  ArrowRight as ArrowRight2,
  CalendarDays,
  Check as Check2,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  LoaderCircle as LoaderCircle2,
  MapPin,
  ShieldCheck as ShieldCheck2,
  Send
} from "lucide-react";

// apps/web/src/ui.tsx
import {
  useState,
  useEffect,
  useRef,
  useId
} from "react";
import {
  ArrowUpRight,
  Check,
  LayoutTemplate,
  LoaderCircle,
  X,
  ArrowRight,
  ShieldCheck,
  LockKeyhole
} from "lucide-react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function Field({
  label,
  hint,
  ...props
}) {
  let id = useId();
  return /* @__PURE__ */ jsxs("label", { className: "field", htmlFor: id, children: [
    /* @__PURE__ */ jsx("span", { id: id + "-label", children: label }),
    /* @__PURE__ */ jsx(
      "input",
      {
        id,
        "aria-labelledby": id + "-label",
        "aria-describedby": hint ? id + "-hint" : void 0,
        ...props
      }
    ),
    hint ? /* @__PURE__ */ jsx("small", { id: id + "-hint", children: hint }) : null
  ] });
}
function Select({
  label,
  children,
  ...props
}) {
  let id = useId();
  return /* @__PURE__ */ jsxs("label", { className: "field", htmlFor: id, children: [
    /* @__PURE__ */ jsx("span", { id: id + "-label", children: label }),
    /* @__PURE__ */ jsx("select", { id, "aria-labelledby": id + "-label", ...props, children })
  ] });
}
function Textarea({
  label,
  ...props
}) {
  let id = useId();
  return /* @__PURE__ */ jsxs("label", { className: "field", htmlFor: id, children: [
    /* @__PURE__ */ jsx("span", { id: id + "-label", children: label }),
    /* @__PURE__ */ jsx("textarea", { id, "aria-labelledby": id + "-label", ...props })
  ] });
}
function Loading({ text: text2 = "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043C \u0434\u0430\u043D\u043D\u044B\u0435\u2026" }) {
  return /* @__PURE__ */ jsxs("div", { className: "loading-state", role: "status", children: [
    /* @__PURE__ */ jsx(LoaderCircle, { size: 24, className: "spin" }),
    text2
  ] });
}
function ErrorBox({ error }) {
  return error ? /* @__PURE__ */ jsx("div", { className: "error-box", role: "alert", children: typeof error == "string" ? error : error.message }) : null;
}

// apps/web/src/booking.tsx
import { Fragment as Fragment2, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var defaults = (c, id) => Object.fromEntries(
  (c.services.find((s) => s.id === id)?.parameters ?? []).map((p) => [
    p.key,
    p.options[0].value
  ])
);
function BookingForm({
  config,
  siteId,
  preview = !1,
  admin = !1,
  onCreated,
  initialService,
  initialParameters,
  handoffRevision = 0,
  initialDate
}) {
  let services = config.services.filter((s) => s.active), [selections, setSelections] = useState2(() => {
    let id = services.find((s) => s.id === initialService)?.id ?? services[0]?.id;
    return id ? [
      {
        serviceId: id,
        parameters: { ...defaults(config, id), ...initialParameters }
      }
    ] : [];
  }), [step, setStep] = useState2(1), [date, setDate] = useState2(
    initialDate ?? dateKey(config.schedule.timezone)
  ), [start, setStart] = useState2(""), [available, setAvailable] = useState2([]), [loading, setLoading] = useState2(!1), [refresh, setRefresh] = useState2(0), [estimate, setEstimate] = useState2(null), [quoteError, setQuoteError] = useState2(null), [name, setName] = useState2(""), [phone, setPhone] = useState2(""), [note, setNote] = useState2(""), [consent, setConsent] = useState2(!1), [website, setWebsite] = useState2(""), [error, setError] = useState2(null), [busy, setBusy] = useState2(!1), [success, setSuccess] = useState2(null), begun = useRef2(Date.now()), lastRequest = useRef2({ fingerprint: "", key: crypto.randomUUID() }), resultRef = useRef2(null), serviceIdsKey = JSON.stringify(selections.map((s) => s.serviceId)), initialParametersKey = JSON.stringify(initialParameters ?? {}), today = dateKey(config.schedule.timezone);
  useEffect2(() => {
    initialService && services.some((s) => s.id === initialService) && (setSelections([
      {
        serviceId: initialService,
        parameters: {
          ...defaults(config, initialService),
          ...initialParameters
        }
      }
    ]), setEstimate(null), setStart(""), setStep(1));
  }, [initialService, initialParametersKey, handoffRevision]);
  function changeSelections(next) {
    setSelections(next), setEstimate(null), setStart(""), setError(null);
  }
  useEffect2(() => {
    let alive = !0;
    if (setQuoteError(null), setEstimate(null), !!selections.length) {
      if (preview) {
        let total = { price: 0, priceMax: 0, duration: 0 };
        for (let selection of selections) {
          let service = services.find((s) => s.id === selection.serviceId);
          if (!service) return;
          let extra = service.parameters.reduce(
            (sum, p) => sum + (p.options.find((o) => o.value === selection.parameters[p.key])?.surcharge ?? 0),
            0
          );
          total.price += service.price + extra, total.priceMax += (service.priceMax ?? service.price) + extra, total.duration += service.duration;
        }
        setEstimate(total);
        return;
      }
      return send(`/api/s/${siteId}/quote`, { services: selections }).then((v) => {
        alive && setEstimate(v);
      }).catch((e) => {
        alive && setQuoteError(e.message);
      }), () => {
        alive = !1;
      };
    }
  }, [selections, preview, siteId, config.services]), useEffect2(() => {
    if (preview || !selections.length) {
      setAvailable([]), setLoading(!1);
      return;
    }
    let alive = !0;
    return setLoading(!0), setStart(""), setError(null), api(
      `/api/s/${siteId}/slots?services=${encodeURIComponent(serviceIdsKey)}&date=${date}`
    ).then((v) => {
      alive && setAvailable(v);
    }).catch((e) => {
      alive && (setAvailable([]), setError(e.message));
    }).finally(() => {
      alive && setLoading(!1);
    }), () => {
      alive = !1;
    };
  }, [siteId, serviceIdsKey, date, refresh, preview, config.schedule]);
  async function submit() {
    if (preview || busy || !selections.length || !estimate || !start) return;
    setBusy(!0), setError(null);
    let payload = {
      services: selections,
      name,
      phone,
      note,
      start,
      consent,
      website
    }, fingerprint = JSON.stringify(payload);
    lastRequest.current.fingerprint !== fingerprint && (lastRequest.current = { fingerprint, key: crypto.randomUUID() });
    try {
      let response = await send(
        `/api/s/${siteId}/${admin ? "admin/" : ""}bookings`,
        {
          ...payload,
          startedAt: begun.current,
          idempotencyKey: lastRequest.current.key
        }
      );
      setSuccess(response), onCreated?.(response);
    } catch (e) {
      setError(e.message), e.status === 409 && (setStep(2), setRefresh((v) => v + 1));
    } finally {
      setBusy(!1);
    }
  }
  return useEffect2(() => {
    success && resultRef.current?.focus();
  }, [success]), success ? /* @__PURE__ */ jsxs2("div", { className: "booking-success", tabIndex: -1, ref: resultRef, children: [
    /* @__PURE__ */ jsx2("div", { className: "success-symbol", children: /* @__PURE__ */ jsx2(CheckCircle2, { size: 34 }) }),
    /* @__PURE__ */ jsxs2("span", { className: "eyebrow", children: [
      "\u0417\u0410\u041F\u0418\u0421\u042C \u2116",
      success.id
    ] }),
    /* @__PURE__ */ jsx2("h3", { children: "\u0412\u0441\u0451 \u0433\u043E\u0442\u043E\u0432\u043E. \u0416\u0434\u0451\u043C \u0432\u0430\u0441!" }),
    /* @__PURE__ */ jsx2("p", { children: "\u0417\u0430\u043F\u0438\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0430. \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0442\u044C \u0435\u0451 \u043F\u043E \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0443 \u043D\u0435 \u043D\u0443\u0436\u043D\u043E." }),
    /* @__PURE__ */ jsxs2("div", { className: "confirmation-details", children: [
      /* @__PURE__ */ jsxs2("span", { children: [
        /* @__PURE__ */ jsx2(CalendarDays, { size: 18 }),
        formatDate(success.start, config.schedule.timezone),
        ",",
        " ",
        formatTime(success.start, config.schedule.timezone)
      ] }),
      /* @__PURE__ */ jsxs2("span", { children: [
        /* @__PURE__ */ jsx2(MapPin, { size: 18 }),
        config.address
      ] }),
      /* @__PURE__ */ jsxs2("span", { children: [
        success.service,
        " ",
        /* @__PURE__ */ jsx2("strong", { children: priceLabel(success.price, success.priceMax) })
      ] })
    ] }),
    success.telegramUrl ? /* @__PURE__ */ jsxs2(
      "a",
      {
        className: "button site-primary full",
        href: success.telegramUrl,
        target: "_blank",
        rel: "noreferrer",
        children: [
          /* @__PURE__ */ jsx2(Send, { size: 17 }),
          "\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C \u0432 Telegram"
        ]
      }
    ) : /* @__PURE__ */ jsx2("p", { className: "muted", children: "Telegram \u043F\u043E\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u043E\u0439. \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043D\u0430 \u0441\u0430\u0439\u0442\u0435." }),
    /* @__PURE__ */ jsxs2(
      "a",
      {
        className: "text-link",
        href: `/s/${siteId}/confirmation#${success.token}`,
        target: "_blank",
        rel: "noreferrer",
        children: [
          "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435",
          /* @__PURE__ */ jsx2(ArrowRight2, { size: 16 })
        ]
      }
    )
  ] }) : /* @__PURE__ */ jsxs2(
    "div",
    {
      className: "booking-form",
      style: { "--accent": config.accent },
      children: [
        /* @__PURE__ */ jsx2("div", { className: "booking-steps", children: ["\u0423\u0441\u043B\u0443\u0433\u0438", "\u0412\u0440\u0435\u043C\u044F", "\u041A\u043E\u043D\u0442\u0430\u043A\u0442\u044B"].map((name2, i) => /* @__PURE__ */ jsxs2(
          "button",
          {
            type: "button",
            className: step === i + 1 ? "current" : step > i + 1 ? "complete" : "",
            "aria-current": step === i + 1 ? "step" : void 0,
            onClick: () => {
              i + 1 < step && setStep(i + 1);
            },
            disabled: i + 1 > step,
            children: [
              /* @__PURE__ */ jsx2("span", { children: step > i + 1 ? /* @__PURE__ */ jsx2(Check2, { size: 13 }) : i + 1 }),
              name2
            ]
          },
          name2
        )) }),
        /* @__PURE__ */ jsxs2(
          "form",
          {
            onSubmit: (e) => {
              e.preventDefault(), step === 1 && selections.length && estimate ? setStep(2) : step === 2 ? setStep(3) : submit();
            },
            children: [
              step === 1 ? /* @__PURE__ */ jsxs2(Fragment2, { children: [
                /* @__PURE__ */ jsx2("h3", { children: "\u0427\u0442\u043E \u043D\u0443\u0436\u043D\u043E \u0441\u0434\u0435\u043B\u0430\u0442\u044C?" }),
                /* @__PURE__ */ jsxs2("fieldset", { className: "service-choice", children: [
                  /* @__PURE__ */ jsx2("legend", { children: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0441\u043B\u0443\u0433\u0438" }),
                  /* @__PURE__ */ jsx2("p", { className: "service-choice-hint", children: "\u041C\u043E\u0436\u043D\u043E \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0443\u0441\u043B\u0443\u0433 \u0437\u0430 \u043E\u0434\u0438\u043D \u0432\u0438\u0437\u0438\u0442." }),
                  services.length ? null : /* @__PURE__ */ jsx2("p", { children: "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0445 \u0443\u0441\u043B\u0443\u0433" }),
                  services.map((s) => /* @__PURE__ */ jsxs2(
                    "label",
                    {
                      className: `service-option ${selections.some((selection) => selection.serviceId === s.id) ? "selected" : ""}`,
                      children: [
                        /* @__PURE__ */ jsx2(
                          "input",
                          {
                            type: "checkbox",
                            name: "services",
                            value: s.id,
                            checked: selections.some(
                              (selection) => selection.serviceId === s.id
                            ),
                            onChange: (e) => changeSelections(
                              e.target.checked ? [
                                ...selections,
                                {
                                  serviceId: s.id,
                                  parameters: defaults(config, s.id)
                                }
                              ] : selections.filter(
                                (selection) => selection.serviceId !== s.id
                              )
                            )
                          }
                        ),
                        /* @__PURE__ */ jsxs2("span", { children: [
                          /* @__PURE__ */ jsx2("strong", { children: s.name }),
                          /* @__PURE__ */ jsxs2("small", { children: [
                            s.duration,
                            " \u043C\u0438\u043D\u0443\u0442"
                          ] })
                        ] }),
                        /* @__PURE__ */ jsxs2("b", { children: [
                          s.priceType === "range" ? "\u043E\u0442 " : "",
                          money(s.price)
                        ] })
                      ]
                    },
                    s.id
                  ))
                ] }),
                selections.map((selection) => {
                  let selectedService = services.find(
                    (s) => s.id === selection.serviceId
                  );
                  return selectedService?.parameters.length ? /* @__PURE__ */ jsxs2(
                    "fieldset",
                    {
                      className: "service-parameters",
                      children: [
                        /* @__PURE__ */ jsx2("legend", { children: selectedService.name }),
                        selectedService.parameters.map((p) => /* @__PURE__ */ jsx2(
                          Select,
                          {
                            label: p.label,
                            value: selection.parameters[p.key] ?? p.options[0].value,
                            onChange: (e) => changeSelections(
                              selections.map(
                                (item) => item.serviceId === selection.serviceId ? {
                                  ...item,
                                  parameters: {
                                    ...item.parameters,
                                    [p.key]: e.target.value
                                  }
                                } : item
                              )
                            ),
                            children: p.options.map((o) => /* @__PURE__ */ jsxs2("option", { value: o.value, children: [
                              o.label,
                              o.surcharge ? ` (+${money(o.surcharge)})` : ""
                            ] }, o.value))
                          },
                          p.key
                        ))
                      ]
                    },
                    selection.serviceId
                  ) : null;
                }),
                !selections.length && services.length ? /* @__PURE__ */ jsx2("p", { className: "service-choice-hint", children: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u043D\u0443 \u0443\u0441\u043B\u0443\u0433\u0443, \u0447\u0442\u043E\u0431\u044B \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C." }) : null,
                /* @__PURE__ */ jsx2(ErrorBox, { error: quoteError })
              ] }) : null,
              step === 2 ? /* @__PURE__ */ jsxs2(Fragment2, { children: [
                /* @__PURE__ */ jsx2("h3", { children: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0434\u043E\u0431\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F" }),
                /* @__PURE__ */ jsx2(
                  Field,
                  {
                    label: `\u0414\u0430\u0442\u0430 \u0432\u0438\u0437\u0438\u0442\u0430 \xB7 ${config.schedule.timezone}`,
                    type: "date",
                    value: date,
                    min: today,
                    max: shiftDay(today, config.schedule.horizon - 1),
                    onChange: (e) => {
                      e.target.value && setDate(e.target.value);
                    },
                    required: !0
                  }
                ),
                /* @__PURE__ */ jsx2("div", { className: "date-chips", children: Array.from({ length: 5 }, (_, i) => shiftDay(today, i)).map(
                  (d) => /* @__PURE__ */ jsxs2(
                    "button",
                    {
                      type: "button",
                      className: d === date ? "selected" : "",
                      onClick: () => setDate(d),
                      children: [
                        /* @__PURE__ */ jsx2("small", { children: (/* @__PURE__ */ new Date(d + "T12:00:00Z")).toLocaleDateString("ru-RU", {
                          weekday: "short"
                        }) }),
                        /* @__PURE__ */ jsx2("b", { children: d.slice(-2) })
                      ]
                    },
                    d
                  )
                ) }),
                preview ? /* @__PURE__ */ jsx2("p", { className: "preview-note", children: "\u0421\u0432\u043E\u0431\u043E\u0434\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u043F\u043E\u044F\u0432\u0438\u0442\u0441\u044F \u043F\u043E\u0441\u043B\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u0438 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u0431\u0430\u0437\u044B." }) : loading ? /* @__PURE__ */ jsx2(Loading, { text: "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C \u0441\u0432\u043E\u0431\u043E\u0434\u043D\u044B\u0435 \u043F\u043E\u0441\u0442\u044B\u2026" }) : available.length ? /* @__PURE__ */ jsx2(
                  "div",
                  {
                    className: "time-grid",
                    role: "group",
                    "aria-label": "\u0421\u0432\u043E\u0431\u043E\u0434\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F",
                    children: available.map((slot) => /* @__PURE__ */ jsx2(
                      "button",
                      {
                        type: "button",
                        "aria-pressed": start === slot.start,
                        className: start === slot.start ? "selected" : "",
                        onClick: () => setStart(slot.start),
                        children: slot.label
                      },
                      slot.start
                    ))
                  }
                ) : /* @__PURE__ */ jsxs2("div", { className: "no-slots", children: [
                  /* @__PURE__ */ jsx2(CalendarDays, { size: 22 }),
                  /* @__PURE__ */ jsx2("p", { children: "\u041D\u0430 \u044D\u0442\u0443 \u0434\u0430\u0442\u0443 \u0441\u0432\u043E\u0431\u043E\u0434\u043D\u043E\u0433\u043E \u0432\u0440\u0435\u043C\u0435\u043D\u0438 \u043D\u0435\u0442." }),
                  /* @__PURE__ */ jsxs2(
                    "button",
                    {
                      type: "button",
                      className: "text-link",
                      disabled: date >= shiftDay(today, config.schedule.horizon - 1),
                      onClick: () => setDate(shiftDay(date, 1)),
                      children: [
                        "\u041F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0434\u0435\u043D\u044C",
                        /* @__PURE__ */ jsx2(ArrowRight2, { size: 15 })
                      ]
                    }
                  )
                ] })
              ] }) : null,
              step === 3 ? /* @__PURE__ */ jsxs2(Fragment2, { children: [
                /* @__PURE__ */ jsx2("h3", { children: "\u041A\u0430\u043A \u043A \u0432\u0430\u043C \u043E\u0431\u0440\u0430\u0449\u0430\u0442\u044C\u0441\u044F?" }),
                /* @__PURE__ */ jsxs2("div", { className: "chosen-summary", children: [
                  /* @__PURE__ */ jsx2(CalendarDays, { size: 16 }),
                  formatDate(start, config.schedule.timezone),
                  ",",
                  " ",
                  formatTime(start, config.schedule.timezone),
                  /* @__PURE__ */ jsx2("button", { type: "button", onClick: () => setStep(2), children: "\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C" })
                ] }),
                /* @__PURE__ */ jsx2(
                  Field,
                  {
                    label: "\u0412\u0430\u0448\u0435 \u0438\u043C\u044F",
                    value: name,
                    onChange: (e) => setName(e.target.value),
                    autoComplete: "given-name",
                    minLength: 2,
                    maxLength: 100,
                    required: !0
                  }
                ),
                /* @__PURE__ */ jsx2(
                  Field,
                  {
                    label: "\u041D\u043E\u043C\u0435\u0440 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430",
                    type: "tel",
                    inputMode: "tel",
                    autoComplete: "tel",
                    placeholder: "+7 (999) 123-45-67",
                    value: phone,
                    onChange: (e) => setPhone(e.target.value),
                    required: !0
                  }
                ),
                /* @__PURE__ */ jsx2(
                  Textarea,
                  {
                    label: "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u2014 \u043F\u043E \u0436\u0435\u043B\u0430\u043D\u0438\u044E",
                    value: note,
                    maxLength: 1500,
                    onChange: (e) => setNote(e.target.value),
                    rows: 2
                  }
                ),
                /* @__PURE__ */ jsxs2("label", { className: "honeypot", "aria-hidden": "true", children: [
                  "\u0412\u0430\u0448 \u0441\u0430\u0439\u0442",
                  /* @__PURE__ */ jsx2(
                    "input",
                    {
                      tabIndex: -1,
                      autoComplete: "off",
                      value: website,
                      onChange: (e) => setWebsite(e.target.value)
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs2("label", { className: "consent-check", children: [
                  /* @__PURE__ */ jsx2(
                    "input",
                    {
                      type: "checkbox",
                      checked: consent,
                      required: !0,
                      onChange: (e) => setConsent(e.target.checked)
                    }
                  ),
                  /* @__PURE__ */ jsxs2("span", { children: [
                    admin ? "\u0421\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043A\u043B\u0438\u0435\u043D\u0442\u0430 \u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0434\u0430\u043D\u043D\u044B\u0445 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E. " : "\u042F \u0434\u0430\u044E ",
                    /* @__PURE__ */ jsx2(
                      "a",
                      {
                        target: "_blank",
                        rel: "noreferrer",
                        href: `/s/${siteId}/consent`,
                        children: "\u0441\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445"
                      }
                    ),
                    " ",
                    "\u0438 \u043E\u0437\u043D\u0430\u043A\u043E\u043C\u043B\u0435\u043D(\u0430) \u0441",
                    " ",
                    /* @__PURE__ */ jsx2(
                      "a",
                      {
                        target: "_blank",
                        rel: "noreferrer",
                        href: `/s/${siteId}/privacy`,
                        children: "\u043F\u043E\u043B\u0438\u0442\u0438\u043A\u043E\u0439 \u043A\u043E\u043D\u0444\u0438\u0434\u0435\u043D\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0438"
                      }
                    ),
                    "."
                  ] })
                ] })
              ] }) : null,
              /* @__PURE__ */ jsx2(ErrorBox, { error }),
              /* @__PURE__ */ jsxs2("div", { className: "estimate-box", children: [
                /* @__PURE__ */ jsxs2("div", { children: [
                  /* @__PURE__ */ jsx2("span", { children: "\u041F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C" }),
                  /* @__PURE__ */ jsx2("strong", { children: estimate ? priceLabel(estimate.price, estimate.priceMax) : selections.length ? "\u0420\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u043C\u2026" : "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0441\u043B\u0443\u0433\u0438" })
                ] }),
                /* @__PURE__ */ jsxs2("small", { children: [
                  /* @__PURE__ */ jsx2(Clock3, { size: 14 }),
                  estimate ? `${estimate.duration} \u043C\u0438\u043D` : "\u2014"
                ] })
              ] }),
              /* @__PURE__ */ jsx2("p", { className: "estimate-disclaimer", children: "\u0418\u0442\u043E\u0433\u043E\u0432\u0430\u044F \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u043C\u043E\u0436\u0435\u0442 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C\u0441\u044F \u043F\u043E\u0441\u043B\u0435 \u0434\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0438." }),
              /* @__PURE__ */ jsxs2("div", { className: "booking-actions", children: [
                step > 1 ? /* @__PURE__ */ jsxs2(
                  "button",
                  {
                    className: "button site-secondary",
                    type: "button",
                    onClick: () => setStep((v) => v - 1),
                    children: [
                      /* @__PURE__ */ jsx2(ChevronLeft, { size: 17 }),
                      "\u041D\u0430\u0437\u0430\u0434"
                    ]
                  }
                ) : null,
                /* @__PURE__ */ jsxs2(
                  "button",
                  {
                    className: "button site-primary",
                    disabled: busy || !estimate || !selections.length || step === 2 && !start || preview && step === 2,
                    children: [
                      busy ? /* @__PURE__ */ jsx2(LoaderCircle2, { size: 17, className: "spin" }) : null,
                      step === 1 ? "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u044F" : step === 2 ? preview ? "\u0417\u0430\u043F\u0438\u0441\u044C \u043F\u043E\u0441\u043B\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438" : "\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C" : "\u0417\u0430\u043F\u0438\u0441\u0430\u0442\u044C\u0441\u044F",
                      /* @__PURE__ */ jsx2(ArrowRight2, { size: 17 })
                    ]
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs2("p", { className: "booking-secure", children: [
                /* @__PURE__ */ jsx2(ShieldCheck2, { size: 13 }),
                "\u0417\u0430\u043F\u0438\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \xB7 \u0431\u0435\u0437 \u043F\u0440\u0435\u0434\u043E\u043F\u043B\u0430\u0442\u044B"
              ] })
            ]
          }
        )
      ]
    }
  );
}

// apps/web/src/site.tsx
import { Fragment as Fragment3, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function SiteBody({
  config,
  siteId,
  preview = !1,
  renderer = "tire"
}) {
  let [selected, setSelected] = useState3(), [selectedParameters, setSelectedParameters] = useState3(), [handoffRevision, setHandoffRevision] = useState3(0), [menu, setMenu] = useState3(!1), [bookingInView, setBookingInView] = useState3(!1), bookingEnabled = config.sections.some((s) => s.id === "booking" && s.visible) && config.services.some((service) => service.active), specialty = config.specialization === "auto" ? "\u0410\u0412\u0422\u041E\u0421\u0415\u0420\u0412\u0418\u0421" : config.specialization === "mixed" ? "\u0428\u0418\u041D\u041E\u041C\u041E\u041D\u0422\u0410\u0416 \u0418 \u0410\u0412\u0422\u041E\u0421\u0415\u0420\u0412\u0418\u0421" : "\u0428\u0418\u041D\u041E\u041C\u041E\u041D\u0422\u0410\u0416", serviceGroups = Object.entries(
    config.services.filter((service) => service.active).reduce((groups, service) => ((groups[service.category || "\u0423\u0441\u043B\u0443\u0433\u0438"] ??= []).push(service), groups), {})
  );
  useEffect3(() => {
    if (preview) return;
    let section = document.getElementById("booking");
    if (!section) return;
    let observer = new IntersectionObserver(
      ([entry]) => setBookingInView(entry.isIntersecting)
    );
    return observer.observe(section), () => observer.disconnect();
  }, [preview, config.sections]);
  function choose(id, parameters) {
    bookingEnabled && (setSelected(id), setSelectedParameters(parameters), setHandoffRevision((revision) => revision + 1), document.getElementById(preview ? "preview-booking" : "booking")?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    }));
  }
  let sections = {
    hero: /* @__PURE__ */ jsxs3("section", { className: "site-hero", children: [
      /* @__PURE__ */ jsxs3("div", { className: "hero-copy", children: [
        /* @__PURE__ */ jsxs3("span", { className: "site-eyebrow", children: [
          /* @__PURE__ */ jsx3("i", {}),
          renderer === "tire" ? specialty : "\u0423\u0421\u041B\u0423\u0413\u0418 \u0414\u041B\u042F \u0412\u0410\u0421",
          " \xB7",
          " ",
          config.city.toUpperCase()
        ] }),
        /* @__PURE__ */ jsx3("h1", { children: config.tagline.split(`
`).map((t, i) => /* @__PURE__ */ jsx3("span", { children: t }, i)) }),
        /* @__PURE__ */ jsx3("p", { children: config.description }),
        /* @__PURE__ */ jsxs3("div", { className: "hero-actions", children: [
          bookingEnabled ? /* @__PURE__ */ jsxs3(
            "a",
            {
              className: "button site-primary",
              href: `#${preview ? "preview-booking" : "booking"}`,
              children: [
                "\u0417\u0430\u043F\u0438\u0441\u0430\u0442\u044C\u0441\u044F \u043E\u043D\u043B\u0430\u0439\u043D",
                /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 20 })
              ]
            }
          ) : null,
          /* @__PURE__ */ jsx3("a", { className: "button site-secondary", href: "#services", children: "\u0423\u0441\u043B\u0443\u0433\u0438 \u0438 \u0446\u0435\u043D\u044B" })
        ] }),
        /* @__PURE__ */ jsxs3("div", { className: "hero-info", children: [
          /* @__PURE__ */ jsxs3("span", { children: [
            /* @__PURE__ */ jsx3(Clock32, { size: 16 }),
            "\u0417\u0430\u043F\u0438\u0441\u044C \u043A \u0443\u0434\u043E\u0431\u043D\u043E\u043C\u0443 \u0432\u0440\u0435\u043C\u0435\u043D\u0438"
          ] }),
          /* @__PURE__ */ jsxs3("span", { children: [
            /* @__PURE__ */ jsx3(Check3, { size: 16 }),
            "\u041F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0446\u0435\u043D\u0430 \u0434\u043E \u0437\u0430\u043F\u0438\u0441\u0438"
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "hero-visual", children: [
        /* @__PURE__ */ jsx3(
          "img",
          {
            src: config.heroImage === "/assets/workshop.svg" && config.specialization && config.specialization !== "tire" ? "/assets/auto-service.svg" : config.heroImage || "/assets/workshop.svg",
            alt: config.heroImage.startsWith("/assets/") ? config.specialization === "auto" || config.specialization === "mixed" ? "\u0418\u043B\u043B\u044E\u0441\u0442\u0440\u0430\u0446\u0438\u044F \u0430\u0432\u0442\u043E\u043C\u043E\u0431\u0438\u043B\u044F \u0432 \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u043E\u0439" : "\u0418\u043B\u043B\u044E\u0441\u0442\u0440\u0430\u0446\u0438\u044F \u043A\u043E\u043B\u0435\u0441\u0430 \u0438 \u0434\u0438\u0441\u043A\u0430" : "\u041C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u0430\u044F",
            width: "1000",
            height: "900",
            fetchPriority: "high"
          }
        ),
        /* @__PURE__ */ jsxs3("div", { className: "hero-image-caption", children: [
          /* @__PURE__ */ jsxs3("span", { children: [
            config.name,
            " / ",
            renderer === "tire" ? specialty : "\u0411\u0418\u0417\u041D\u0415\u0421"
          ] }),
          /* @__PURE__ */ jsxs3("span", { children: [
            "\u0412\u041D\u0418\u041C\u0410\u041D\u0418\u0415 \u041A \u0414\u0415\u0422\u0410\u041B\u042F\u041C",
            /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 15 })
          ] })
        ] })
      ] })
    ] }),
    services: /* @__PURE__ */ jsxs3("section", { className: "site-section", id: "services", children: [
      /* @__PURE__ */ jsxs3("div", { className: "site-section-heading", children: [
        /* @__PURE__ */ jsxs3("div", { children: [
          /* @__PURE__ */ jsx3("span", { className: "eyebrow", children: "01 / \u0423\u0421\u041B\u0423\u0413\u0418" }),
          /* @__PURE__ */ jsx3("h2", { children: renderer === "tire" ? "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0443\u0436\u043D\u044B\u0435 \u0440\u0430\u0431\u043E\u0442\u044B \u0438 \u0443\u0437\u043D\u0430\u0439\u0442\u0435 \u0446\u0435\u043D\u0443." : "\u0420\u0435\u0448\u0435\u043D\u0438\u044F \u0434\u043B\u044F \u0432\u0430\u0448\u0438\u0445 \u0437\u0430\u0434\u0430\u0447." })
        ] }),
        bookingEnabled ? /* @__PURE__ */ jsxs3(
          "a",
          {
            href: `#${preview ? "preview-booking" : "booking"}`,
            className: "text-link",
            children: [
              "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u044F",
              /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 17 })
            ]
          }
        ) : null
      ] }),
      serviceGroups.map(([category, services]) => /* @__PURE__ */ jsxs3("div", { className: "service-category", children: [
        /* @__PURE__ */ jsx3("h3", { className: "service-category-title", children: category }),
        /* @__PURE__ */ jsx3("div", { className: "service-grid", children: (services ?? []).map((s, i) => /* @__PURE__ */ jsxs3("article", { className: "service-card", children: [
          /* @__PURE__ */ jsxs3("div", { className: "service-card-top", children: [
            /* @__PURE__ */ jsx3("div", { className: "service-icon", children: i % 2 ? /* @__PURE__ */ jsx3(Wrench, { size: 23 }) : /* @__PURE__ */ jsx3(Disc3, { size: 25 }) }),
            /* @__PURE__ */ jsx3("span", { children: String(config.services.indexOf(s) + 1).padStart(2, "0") })
          ] }),
          /* @__PURE__ */ jsx3("h3", { children: s.name }),
          /* @__PURE__ */ jsx3("p", { children: s.description }),
          /* @__PURE__ */ jsxs3("div", { className: "service-card-footer", children: [
            /* @__PURE__ */ jsxs3("div", { children: [
              /* @__PURE__ */ jsx3("strong", { children: priceLabel(
                s.price,
                s.priceType === "range" ? s.priceMax : s.price
              ) }),
              /* @__PURE__ */ jsxs3("small", { children: [
                s.duration,
                " \u043C\u0438\u043D\u0443\u0442"
              ] })
            ] }),
            bookingEnabled ? /* @__PURE__ */ jsx3(
              "button",
              {
                "aria-label": `\u0417\u0430\u043F\u0438\u0441\u0430\u0442\u044C\u0441\u044F: ${s.name}`,
                className: "round-arrow",
                onClick: () => choose(s.id),
                children: /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 21 })
              }
            ) : null
          ] })
        ] }, s.id)) })
      ] }, category)),
      bookingEnabled && serviceGroups.length ? /* @__PURE__ */ jsxs3("div", { className: "service-next-step", children: [
        /* @__PURE__ */ jsx3("p", { children: "\u041C\u043E\u0436\u043D\u043E \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0443\u0441\u043B\u0443\u0433 \u0437\u0430 \u043E\u0434\u0438\u043D \u0432\u0438\u0437\u0438\u0442. \u041E\u043A\u043E\u043D\u0447\u0430\u0442\u0435\u043B\u044C\u043D\u0443\u044E \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0443\u0442\u043E\u0447\u043D\u0438\u043C \u043F\u043E\u0441\u043B\u0435 \u0441\u043E\u0433\u043B\u0430\u0441\u043E\u0432\u0430\u043D\u0438\u044F \u0440\u0430\u0431\u043E\u0442." }),
        /* @__PURE__ */ jsxs3(
          "a",
          {
            className: "button site-primary",
            href: `#${preview ? "preview-booking" : "booking"}`,
            children: [
              "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u044F ",
              /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 18 })
            ]
          }
        )
      ] }) : null
    ] }),
    calculator: /* @__PURE__ */ jsx3(
      Calculator,
      {
        config,
        siteId,
        preview,
        bookingEnabled,
        phone: config.phone,
        choose
      }
    ),
    booking: /* @__PURE__ */ jsxs3(
      "section",
      {
        className: "site-section booking-section",
        id: preview ? "preview-booking" : "booking",
        children: [
          /* @__PURE__ */ jsxs3("div", { className: "booking-intro", children: [
            /* @__PURE__ */ jsx3("span", { className: "eyebrow", children: "03 / \u041E\u041D\u041B\u0410\u0419\u041D-\u0417\u0410\u041F\u0418\u0421\u042C" }),
            /* @__PURE__ */ jsxs3("h2", { children: [
              "\u0412\u0430\u0448\u0435 \u0432\u0440\u0435\u043C\u044F \u2014",
              /* @__PURE__ */ jsx3("br", {}),
              "\u0443\u0436\u0435 \u0432 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0438."
            ] }),
            /* @__PURE__ */ jsxs3("p", { children: [
              "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0443\u0441\u043B\u0443\u0433\u0438 \u0438 \u0441\u0432\u043E\u0431\u043E\u0434\u043D\u044B\u0439 \u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B.",
              /* @__PURE__ */ jsx3("br", {}),
              "\u041E\u0441\u0442\u0430\u043B\u044C\u043D\u043E\u0435 \u043C\u044B \u0431\u0435\u0440\u0451\u043C \u043D\u0430 \u0441\u0435\u0431\u044F."
            ] }),
            /* @__PURE__ */ jsxs3("div", { className: "booking-points", children: [
              /* @__PURE__ */ jsxs3("span", { children: [
                /* @__PURE__ */ jsx3(CheckCircle, {}),
                "\u0411\u0435\u0437 \u0437\u0432\u043E\u043D\u043A\u043E\u0432 \u0438 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u044F \u043E\u0442\u0432\u0435\u0442\u0430"
              ] }),
              /* @__PURE__ */ jsxs3("span", { children: [
                /* @__PURE__ */ jsx3(CheckCircle, {}),
                "\u041F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0446\u0435\u043D\u0430 \u0434\u043E \u0432\u0438\u0437\u0438\u0442\u0430"
              ] }),
              /* @__PURE__ */ jsxs3("span", { children: [
                /* @__PURE__ */ jsx3(CheckCircle, {}),
                "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u0441\u0440\u0430\u0437\u0443 \u043D\u0430 \u0441\u0430\u0439\u0442\u0435"
              ] })
            ] }),
            /* @__PURE__ */ jsxs3("div", { className: "booking-contact", children: [
              /* @__PURE__ */ jsx3(Phone2, { size: 20 }),
              /* @__PURE__ */ jsxs3("div", { children: [
                /* @__PURE__ */ jsx3("small", { children: "\u041F\u0440\u0435\u0434\u043F\u043E\u0447\u0438\u0442\u0430\u0435\u0442\u0435 \u043F\u043E\u0437\u0432\u043E\u043D\u0438\u0442\u044C?" }),
                /* @__PURE__ */ jsx3("a", { href: `tel:${config.phone.replace(/[^+\d]/g, "")}`, children: config.phone || "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0442\u0435\u043B\u0435\u0444\u043E\u043D \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445" })
              ] })
            ] })
          ] }),
          /* @__PURE__ */ jsx3(
            BookingForm,
            {
              config,
              siteId,
              preview,
              initialService: selected,
              initialParameters: selectedParameters,
              handoffRevision
            }
          )
        ]
      }
    ),
    benefits: config.benefits.length ? /* @__PURE__ */ jsxs3("section", { className: "site-section benefits-section", children: [
      /* @__PURE__ */ jsx3("span", { className: "eyebrow", children: "\u041D\u0410\u0428 \u041F\u041E\u0414\u0425\u041E\u0414" }),
      /* @__PURE__ */ jsx3("h2", { children: "\u041F\u0440\u043E\u0441\u0442\u043E. \u041F\u043E\u043D\u044F\u0442\u043D\u043E. \u041F\u043E \u0434\u0435\u043B\u0443." }),
      /* @__PURE__ */ jsx3("div", { className: "benefit-grid", children: config.benefits.map((b, i) => /* @__PURE__ */ jsxs3("div", { children: [
        /* @__PURE__ */ jsxs3("span", { children: [
          "0",
          i + 1
        ] }),
        /* @__PURE__ */ jsx3("h3", { children: b.title }),
        /* @__PURE__ */ jsx3("p", { children: b.text })
      ] }, i)) })
    ] }) : null,
    gallery: config.gallery.length ? /* @__PURE__ */ jsxs3("section", { className: "site-section", children: [
      /* @__PURE__ */ jsx3("span", { className: "eyebrow", children: "\u041C\u0410\u0421\u0422\u0415\u0420\u0421\u041A\u0410\u042F \u0412 \u0414\u0415\u0422\u0410\u041B\u042F\u0425" }),
      /* @__PURE__ */ jsx3("h2", { children: "\u041F\u043E\u0437\u043D\u0430\u043A\u043E\u043C\u0438\u043C\u0441\u044F \u0431\u043B\u0438\u0436\u0435." }),
      /* @__PURE__ */ jsx3("div", { className: "gallery-grid", children: config.gallery.map((im, i) => /* @__PURE__ */ jsxs3("figure", { children: [
        /* @__PURE__ */ jsx3(
          "img",
          {
            src: im.src,
            alt: im.caption,
            loading: "lazy",
            width: "600",
            height: "400"
          }
        ),
        /* @__PURE__ */ jsx3("figcaption", { children: im.caption })
      ] }, i)) })
    ] }) : null,
    reviews: config.reviews.length ? /* @__PURE__ */ jsxs3("section", { className: "site-section", children: [
      /* @__PURE__ */ jsx3("span", { className: "eyebrow", children: "\u0421\u041B\u041E\u0412\u041E \u041A\u041B\u0418\u0415\u041D\u0422\u0410\u041C" }),
      /* @__PURE__ */ jsx3("h2", { children: "\u041E\u043F\u044B\u0442, \u043A\u043E\u0442\u043E\u0440\u044B\u043C \u0434\u0435\u043B\u044F\u0442\u0441\u044F." }),
      /* @__PURE__ */ jsx3("div", { className: "review-grid", children: config.reviews.map((r, i) => /* @__PURE__ */ jsxs3("blockquote", { children: [
        /* @__PURE__ */ jsxs3("p", { children: [
          "\xAB",
          r.text,
          "\xBB"
        ] }),
        /* @__PURE__ */ jsx3("cite", { children: r.name }),
        /* @__PURE__ */ jsx3("small", { children: r.source })
      ] }, i)) })
    ] }) : null,
    contacts: /* @__PURE__ */ jsxs3("section", { className: "site-section contact-section", id: "contacts", children: [
      /* @__PURE__ */ jsxs3("div", { children: [
        /* @__PURE__ */ jsx3("span", { className: "eyebrow", children: "\u0411\u0423\u0414\u0415\u041C \u0420\u0410\u0414\u042B \u0412\u0410\u0421 \u0412\u0418\u0414\u0415\u0422\u042C" }),
        /* @__PURE__ */ jsxs3("h2", { children: [
          "\u0412\u0441\u0442\u0440\u0435\u0442\u0438\u043C\u0441\u044F",
          /* @__PURE__ */ jsx3("br", {}),
          "\u0432 \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u043E\u0439."
        ] }),
        /* @__PURE__ */ jsxs3("p", { className: "contact-address", children: [
          /* @__PURE__ */ jsx3(MapPin2, { size: 21 }),
          config.city,
          ", ",
          config.address || "\u0410\u0434\u0440\u0435\u0441 \u043F\u043E\u044F\u0432\u0438\u0442\u0441\u044F \u043F\u043E\u0441\u043B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438"
        ] }),
        /* @__PURE__ */ jsxs3("div", { className: "contact-links", children: [
          /* @__PURE__ */ jsxs3("a", { href: `tel:${config.phone.replace(/[^+\d]/g, "")}`, children: [
            /* @__PURE__ */ jsx3(Phone2, { size: 19 }),
            config.phone
          ] }),
          config.telegram ? /* @__PURE__ */ jsxs3(
            "a",
            {
              href: `https://t.me/${config.telegram}`,
              target: "_blank",
              rel: "noreferrer",
              children: [
                /* @__PURE__ */ jsx3(Send2, { size: 18 }),
                "\u041D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0432 Telegram",
                /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 16 })
              ]
            }
          ) : null,
          config.links.whatsapp ? /* @__PURE__ */ jsxs3("a", { href: `https://wa.me/${config.links.whatsapp.replace(/\D/g, "")}`, target: "_blank", rel: "noreferrer", children: [
            "WhatsApp ",
            /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 16 })
          ] }) : null,
          config.links.vk ? /* @__PURE__ */ jsxs3("a", { href: config.links.vk, target: "_blank", rel: "noreferrer", children: [
            "\u0412\u041A\u043E\u043D\u0442\u0430\u043A\u0442\u0435 ",
            /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 16 })
          ] }) : null
        ] }),
        /* @__PURE__ */ jsxs3(
          "a",
          {
            className: "button site-primary",
            href: config.links.map || `https://yandex.ru/maps/?text=${encodeURIComponent(config.city + " " + config.address)}`,
            target: "_blank",
            rel: "noreferrer",
            children: [
              /* @__PURE__ */ jsx3(Navigation, { size: 17 }),
              "\u041F\u043E\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u043C\u0430\u0440\u0448\u0440\u0443\u0442",
              /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 17 })
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "hours-card", children: [
        /* @__PURE__ */ jsxs3("h3", { children: [
          /* @__PURE__ */ jsx3(Clock32, { size: 20 }),
          "\u0427\u0430\u0441\u044B \u0440\u0430\u0431\u043E\u0442\u044B"
        ] }),
        [
          "\u041F\u043E\u043D\u0435\u0434\u0435\u043B\u044C\u043D\u0438\u043A",
          "\u0412\u0442\u043E\u0440\u043D\u0438\u043A",
          "\u0421\u0440\u0435\u0434\u0430",
          "\u0427\u0435\u0442\u0432\u0435\u0440\u0433",
          "\u041F\u044F\u0442\u043D\u0438\u0446\u0430",
          "\u0421\u0443\u0431\u0431\u043E\u0442\u0430",
          "\u0412\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u0435"
        ].map((day, i) => /* @__PURE__ */ jsxs3("div", { className: "hours-row", children: [
          /* @__PURE__ */ jsx3("span", { children: day }),
          /* @__PURE__ */ jsx3("strong", { children: config.schedule.week[String(i + 1)]?.map((r) => `${r.start}\u2013${r.end}`).join(", ") || "\u0412\u044B\u0445\u043E\u0434\u043D\u043E\u0439" })
        ] }, day)),
        /* @__PURE__ */ jsxs3("small", { children: [
          "\u0412\u0440\u0435\u043C\u044F \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u043E\u0439: ",
          config.schedule.timezone,
          ". \u0418\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u0443\u0447\u0442\u0435\u043D\u044B \u0432 \u043E\u043D\u043B\u0430\u0439\u043D-\u0437\u0430\u043F\u0438\u0441\u0438."
        ] })
      ] })
    ] })
  };
  return /* @__PURE__ */ jsxs3(
    "div",
    {
      className: `customer-site font-${config.font} ${preview ? "is-preview" : ""}`,
      style: {
        "--accent": config.accent,
        "--on-accent": contrast(config.accent)
      },
      children: [
        config.demo ? /* @__PURE__ */ jsx3("div", { className: "site-demo-banner", children: "\u0414\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u043E\u043D\u043D\u0430\u044F \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u0430\u044F \xB7 \u0432\u0441\u0435 \u043A\u043E\u043D\u0442\u0430\u043A\u0442\u044B \u0438 \u0437\u0430\u043F\u0438\u0441\u0438 \u0432\u044B\u043C\u044B\u0448\u043B\u0435\u043D\u044B" }) : null,
        /* @__PURE__ */ jsxs3("header", { className: "site-header", children: [
          /* @__PURE__ */ jsxs3("a", { className: "shop-brand", href: preview ? "#" : `/s/${siteId}`, children: [
            config.logo ? /* @__PURE__ */ jsx3("img", { src: config.logo, alt: "", width: "38", height: "38" }) : /* @__PURE__ */ jsx3(Disc3, { size: 31 }),
            /* @__PURE__ */ jsxs3("span", { children: [
              config.name,
              /* @__PURE__ */ jsx3("small", { children: renderer === "tire" ? specialty : "\u041B\u041E\u041A\u0410\u041B\u042C\u041D\u042B\u0419 \u0411\u0418\u0417\u041D\u0415\u0421" })
            ] })
          ] }),
          /* @__PURE__ */ jsxs3("nav", { className: menu ? "open" : "", "aria-label": "\u041C\u0435\u043D\u044E \u0441\u0430\u0439\u0442\u0430", children: [
            /* @__PURE__ */ jsx3("a", { href: "#services", onClick: () => setMenu(!1), children: "\u0423\u0441\u043B\u0443\u0433\u0438 \u0438 \u0446\u0435\u043D\u044B" }),
            bookingEnabled ? /* @__PURE__ */ jsx3(
              "a",
              {
                href: `#${preview ? "preview-booking" : "booking"}`,
                onClick: () => setMenu(!1),
                children: "\u041E\u043D\u043B\u0430\u0439\u043D-\u0437\u0430\u043F\u0438\u0441\u044C"
              }
            ) : null,
            /* @__PURE__ */ jsx3("a", { href: "#contacts", onClick: () => setMenu(!1), children: "\u041A\u043E\u043D\u0442\u0430\u043A\u0442\u044B" })
          ] }),
          /* @__PURE__ */ jsxs3(
            "a",
            {
              className: "shop-phone",
              href: `tel:${config.phone.replace(/[^+\d]/g, "")}`,
              children: [
                /* @__PURE__ */ jsx3(Phone2, { size: 15 }),
                config.phone
              ]
            }
          ),
          /* @__PURE__ */ jsx3(
            "button",
            {
              className: "mobile-menu",
              "aria-label": menu ? "\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u043C\u0435\u043D\u044E" : "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043C\u0435\u043D\u044E",
              "aria-expanded": menu,
              onClick: () => setMenu((v) => !v),
              children: menu ? "\u0417\u0430\u043A\u0440\u044B\u0442\u044C" : "\u041C\u0435\u043D\u044E"
            }
          )
        ] }),
        /* @__PURE__ */ jsx3("main", { id: preview ? "preview-main" : "main", children: config.sections.filter((s) => s.visible).map((s) => /* @__PURE__ */ jsx3("div", { children: sections[s.id] }, s.id)) }),
        /* @__PURE__ */ jsxs3("footer", { className: "site-footer", children: [
          /* @__PURE__ */ jsxs3("div", { children: [
            /* @__PURE__ */ jsxs3(
              "a",
              {
                className: "shop-brand",
                href: `#${preview ? "preview-main" : "main"}`,
                children: [
                  /* @__PURE__ */ jsx3(Disc3, { size: 24 }),
                  config.name
                ]
              }
            ),
            /* @__PURE__ */ jsxs3("span", { children: [
              "\xA9 ",
              (/* @__PURE__ */ new Date()).getFullYear(),
              " ",
              config.legal.operator || config.name,
              config.legal.inn ? ` \xB7 \u0418\u041D\u041D ${config.legal.inn}` : ""
            ] })
          ] }),
          /* @__PURE__ */ jsxs3("div", { children: [
            /* @__PURE__ */ jsx3("a", { href: `/s/${siteId}/privacy`, children: "\u041F\u043E\u043B\u0438\u0442\u0438\u043A\u0430 \u043A\u043E\u043D\u0444\u0438\u0434\u0435\u043D\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0438" }),
            /* @__PURE__ */ jsx3("a", { href: `/s/${siteId}/consent`, children: "\u0421\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0434\u0430\u043D\u043D\u044B\u0445" }),
            /* @__PURE__ */ jsx3("span", { children: "\u0421\u0434\u0435\u043B\u0430\u043D\u043E \u0441 \u0432\u043D\u0438\u043C\u0430\u043D\u0438\u0435\u043C \u043A \u0432\u0430\u0448\u0435\u043C\u0443 \u0432\u0440\u0435\u043C\u0435\u043D\u0438" })
          ] })
        ] }),
        !preview && bookingEnabled && !bookingInView ? /* @__PURE__ */ jsxs3("a", { className: "mobile-booking button site-primary", href: "#booking", children: [
          "\u0417\u0430\u043F\u0438\u0441\u0430\u0442\u044C\u0441\u044F \u043E\u043D\u043B\u0430\u0439\u043D",
          /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 19 })
        ] }) : null
      ]
    }
  );
}
function CheckCircle() {
  return /* @__PURE__ */ jsx3("span", { className: "check-circle", children: /* @__PURE__ */ jsx3(Check3, { size: 14 }) });
}
function contrast(hex) {
  let rgb = hex.replace("#", "").match(/.{2}/g).map((c) => parseInt(c, 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.179 ? "#101611" : "#ffffff";
}
function Calculator({
  config,
  siteId,
  preview,
  bookingEnabled,
  phone,
  choose
}) {
  let [id, setId] = useState3(config.services.find((s) => s.active)?.id ?? ""), [params, setParams] = useState3({}), [result, setResult] = useState3(
    null
  ), [error, setError] = useState3(null), activeServices = config.services.filter((s) => s.active), service = activeServices.find((s) => s.id === id) ?? activeServices[0], effectiveId = service?.id ?? "", parameters = Object.fromEntries(
    (service?.parameters ?? []).map((p) => [
      p.key,
      params[p.key] ?? p.options[0].value
    ])
  ), key = JSON.stringify(parameters);
  return useEffect3(() => {
    let alive = !0;
    if (!service) {
      setResult(null), setError(null);
      return;
    }
    if (setError(null), preview) {
      let extra = service.parameters.reduce(
        (a, p) => a + (p.options.find((o) => o.value === parameters[p.key])?.surcharge ?? 0),
        0
      );
      setResult({
        price: service.price + extra,
        priceMax: (service.priceMax ?? service.price) + extra
      });
      return;
    }
    return setResult(null), send(`/api/s/${siteId}/quote`, {
      services: [{ serviceId: effectiveId, parameters }]
    }).then((r) => {
      alive && setResult(r);
    }).catch((e) => {
      alive && setError(e.message);
    }), () => {
      alive = !1;
    };
  }, [effectiveId, key, siteId, preview, config.services]), /* @__PURE__ */ jsxs3("section", { className: "site-section calculator-section", id: "calculator", children: [
    /* @__PURE__ */ jsxs3("div", { children: [
      /* @__PURE__ */ jsx3("span", { className: "eyebrow", children: "02 / \u041F\u041E\u041D\u042F\u0422\u041D\u0410\u042F \u0421\u0422\u041E\u0418\u041C\u041E\u0421\u0422\u042C" }),
      /* @__PURE__ */ jsxs3("h2", { children: [
        "\u041D\u0438\u043A\u0430\u043A\u0438\u0445 \u0434\u043E\u0433\u0430\u0434\u043E\u043A.",
        /* @__PURE__ */ jsx3("br", {}),
        "\u041F\u043E\u0441\u0447\u0438\u0442\u0430\u0435\u043C \u0437\u0430\u0440\u0430\u043D\u0435\u0435."
      ] }),
      /* @__PURE__ */ jsxs3("p", { children: [
        "\u041D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0434\u0435\u0442\u0430\u043B\u0435\u0439 \u2014 \u0438 \u0432\u044B \u0437\u043D\u0430\u0435\u0442\u0435",
        /* @__PURE__ */ jsx3("br", {}),
        "\u043F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u0443\u044E \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0440\u0430\u0431\u043E\u0442."
      ] })
    ] }),
    /* @__PURE__ */ jsxs3("div", { className: "calculator-controls", children: [
      /* @__PURE__ */ jsx3(
        Select,
        {
          label: "\u0423\u0441\u043B\u0443\u0433\u0430",
          value: effectiveId,
          onChange: (e) => {
            setId(e.target.value), setParams({});
          },
          children: activeServices.length ? activeServices.map((s) => /* @__PURE__ */ jsx3("option", { value: s.id, children: s.name }, s.id)) : /* @__PURE__ */ jsx3("option", { value: "", children: "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0445 \u0443\u0441\u043B\u0443\u0433" })
        }
      ),
      /* @__PURE__ */ jsx3("div", { className: "form-grid", children: service?.parameters.map((p) => /* @__PURE__ */ jsx3(
        Select,
        {
          label: p.label,
          value: parameters[p.key],
          onChange: (e) => setParams((v) => ({ ...v, [p.key]: e.target.value })),
          children: p.options.map((o) => /* @__PURE__ */ jsx3("option", { value: o.value, children: o.label }, o.value))
        },
        p.key
      )) }),
      /* @__PURE__ */ jsx3(ErrorBox, { error }),
      /* @__PURE__ */ jsxs3("div", { className: "calculator-total", children: [
        /* @__PURE__ */ jsxs3("div", { children: [
          /* @__PURE__ */ jsx3("small", { children: "\u041F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u043E" }),
          /* @__PURE__ */ jsx3("strong", { children: service ? result ? priceLabel(result.price, result.priceMax) : "\u0420\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u043C\u2026" : "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0445 \u0443\u0441\u043B\u0443\u0433" })
        ] }),
        bookingEnabled && service ? /* @__PURE__ */ jsxs3(
          "button",
          {
            className: "button site-primary",
            onClick: () => choose(effectiveId, parameters),
            children: [
              "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u044F",
              /* @__PURE__ */ jsx3(ArrowUpRight2, { size: 19 })
            ]
          }
        ) : /* @__PURE__ */ jsxs3(
          "a",
          {
            className: "button site-primary",
            href: `tel:${phone.replace(/[^+\d]/g, "")}`,
            children: [
              "\u041F\u043E\u0437\u0432\u043E\u043D\u0438\u0442\u044C \u0432 \u043C\u0430\u0441\u0442\u0435\u0440\u0441\u043A\u0443\u044E",
              /* @__PURE__ */ jsx3(Phone2, { size: 18 })
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsx3("small", { className: "muted", children: "\u0418\u0442\u043E\u0433\u043E\u0432\u0443\u044E \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u043C\u0430\u0441\u0442\u0435\u0440 \u0443\u0442\u043E\u0447\u043D\u0438\u0442 \u043F\u043E\u0441\u043B\u0435 \u0434\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0438." })
    ] })
  ] });
}

// apps/api/server.ts
var sourceDir = process.cwd();
existsSync5(join5(sourceDir, ".env")) && process.loadEnvFile(join5(sourceDir, ".env"));
var production = process.env.NODE_ENV === "production", demoMode = !production && process.env.DEMO_MODE !== "false", port = Number(process.env.PORT ?? 3100), host = process.env.HOST ?? "127.0.0.1", origin = (process.env.PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/$/, ""), url = new URL(origin);
if (production && (url.protocol !== "https:" || (!process.env.PUBLIC_ORIGIN && !process.env.RENDER_EXTERNAL_URL)))
  throw new Error(
    "Production requires PUBLIC_ORIGIN=https://your-domain.ru and a TLS reverse proxy"
  );
if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
  throw new Error(
    "PUBLIC_ORIGIN must contain only scheme, host and optional port"
  );
for (let key of ["STUDIO_PASSWORD", "ADMIN_PASSWORD"])
  if (process.env[key] && process.env[key].length < 12)
    throw new Error(`${key} requires at least 12 characters`);
var singleSite = process.env.SITE_ID, store = new Store(process.env.DATA_DIR ?? ".local", !!singleSite);
initialize(store, { demoMode, singleSite, sourceDir });
var app = createApp(store, {
  origin,
  production,
  demoMode,
  singleSite,
  sourceDir
}), proxies = new BlockList();
proxies.addSubnet("127.0.0.0", 8, "ipv4");
proxies.addSubnet("10.0.0.0", 8, "ipv4");
proxies.addSubnet("172.16.0.0", 12, "ipv4");
proxies.addSubnet("192.168.0.0", 16, "ipv4");
proxies.addAddress("::1", "ipv6");
var listener = getRequestListener((request, env) => {
  let peer = (env.incoming.socket.remoteAddress ?? "").replace(/^::ffff:/, ""), forwarded = request.headers.get("X-Pitlane-Client-IP");
  return process.env.TRUST_PROXY === "true" && isIP(peer) && proxies.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4") && forwarded && isIP(forwarded) && (peer = forwarded), app.fetch(request, { remoteAddress: peer });
}), mime = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon"
}, escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"), server = createServer(async (req, res) => {
  try {
    let path = new URL(req.url ?? "/", origin).pathname;
    if (path.startsWith("/api/") || path.startsWith("/uploads/") || path.endsWith("/robots.txt") || path.endsWith("/sitemap.xml")) {
      await listener(req, res);
      return;
    }
    if (path === "/") {
      res.writeHead(302, {
        Location: singleSite ? `/s/${singleSite}` : "/studio"
      }), res.end();
      return;
    }
    if (singleSite && !path.startsWith(`/s/${singleSite}`) && !path.startsWith("/assets/") && !path.startsWith("/src/") && !path.startsWith("/@") && !path.startsWith("/node_modules/")) {
      res.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" }), res.end("\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
      return;
    }
    if (!["GET", "HEAD"].includes(req.method ?? "GET")) {
      res.writeHead(405), res.end();
      return;
    }
    let root = production ? join5(sourceDir, "dist/client") : join5(sourceDir, "public"), asset = resolve3(root, "." + decodeURIComponent(path));
    if (path.startsWith("/assets/") && asset.startsWith(root + "/") && existsSync5(asset) && statSync(asset).isFile()) {
      res.writeHead(200, {
        "Content-Type": mime[extname(asset)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": production ? "public,max-age=86400" : "no-cache"
      }), res.end(req.method === "HEAD" ? void 0 : readFileSync5(asset));
      return;
    }
    if (path.startsWith("/assets/")) {
      res.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" }), res.end("\u0424\u0430\u0439\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
      return;
    }
    if (!production && (path.startsWith("/src/") || path.startsWith("/@") || path.startsWith("/node_modules/"))) {
      vite.middlewares(req, res);
      return;
    }
    let match = path.match(/^\/s\/([a-z][a-z0-9-]+)(?:\/(.*))?$/), html = readFileSync5(
      join5(
        sourceDir,
        production ? "dist/client/index.html" : "apps/web/index.html"
      ),
      "utf8"
    );
    if (match && !match[2]) {
      let db = store.tenant(match[1]);
      if (!db) {
        res.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" }), res.end("\u0421\u0430\u0439\u0442 \u0435\u0449\u0451 \u043D\u0435 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D");
        return;
      }
      let { config, template } = readConfig(db), title = escape(config.seo.title || config.name), description = escape(config.seo.description);
      html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`).replace(
        /<meta name="description"[^>]*>/,
        `<meta name="description" content="${description}">`
      ), config.logo && (html = html.replace(
        /<link rel="icon"[^>]*>/,
        `<link rel="icon" href="${escape(config.logo)}">`
      ));
      let canonical = origin + `/s/${match[1]}`, meta = `<link rel="canonical" href="${escape(canonical)}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:type" content="website"><meta property="og:url" content="${escape(canonical)}"><meta property="og:image" content="${escape(origin + (config.heroImage || "/assets/workshop.svg"))}">`, structured = {
        "@context": "https://schema.org",
        "@type": template.renderer === "tire" ? "AutoRepair" : "LocalBusiness",
        name: config.name,
        telephone: config.phone,
        address: {
          "@type": "PostalAddress",
          streetAddress: config.address,
          addressLocality: config.city,
          addressCountry: "RU"
        },
        url: canonical
      };
      meta += `<script type="application/ld+json">${JSON.stringify(structured).replaceAll("<", "\\u003c")}</script>`, html = html.replace("</head>", meta + "</head>"), html = html.replace(
        '<div id="root"></div>',
        `<div id="root">${renderToString(createElement(SiteBody, { config, siteId: match[1], renderer: template.renderer }))}</div><script type="application/json" id="site-data">${JSON.stringify({ config, template: { renderer: template.renderer } }).replaceAll("<", "\\u003c")}</script>`
      );
    }
    production || (html = await vite.transformIndexHtml(path, html));
    let privatePage = !match || !!match[2];
    res.writeHead(200, {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      ...privatePage ? { "X-Robots-Tag": "noindex,nofollow" } : {},
      ...production ? {
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
      } : {}
    }), res.end(req.method === "HEAD" ? void 0 : html);
  } catch (error) {
    console.error("Server request failed:", error.message), res.headersSent || res.writeHead(500, { "Content-Type": "text/plain;charset=utf-8" }), res.end("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443");
  }
}), vite = production ? null : await (await import("vite")).createServer({
  configFile: join5(sourceDir, "vite.config.ts"),
  server: { middlewareMode: !0, hmr: { server } },
  appType: "custom"
}), notificationRunning = !1, worker = setInterval(async () => {
  if (!notificationRunning) {
    notificationRunning = !0;
    try {
      let ids = singleSite ? [singleSite] : store.studio.prepare("SELECT id FROM projects WHERE status='local'").all().map((p) => p.id);
      for (let id of ids) {
        let db = store.tenant(id);
        db && (enqueueReminders(db), await deliver(db, telegramSettings(id, db, store.dir), origin, id));
      }
    } catch {
      console.error("Notification worker failed; bookings remain saved");
    } finally {
      notificationRunning = !1;
    }
  }
}, 15e3);
worker.unref();
server.listen(port, host, () => {
  console.log(
    `Template Studio: ${origin}${singleSite ? "/s/" + singleSite : "/studio"}`
  ), console.log(`Data directory: ${store.dir}`), console.log(
    "First-start passwords: DATA_DIR/access.json (not tracked in Git)"
  );
});
function shutdown() {
  clearInterval(worker), server.close(() => {
    vite?.close(), store.close(), process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
