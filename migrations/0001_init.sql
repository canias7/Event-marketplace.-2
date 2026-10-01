-- Core schema for the EventVendora marketplace.

CREATE TABLE categories (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order  INT  NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE, -- always stored lowercased
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, -- sha256 of the cookie value; raw tokens are never stored
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE vendors (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  category_id            INT NOT NULL REFERENCES categories(id),
  business_name          TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  city                   TEXT NOT NULL DEFAULT '',
  description            TEXT NOT NULL DEFAULT '',
  phone                  TEXT NOT NULL DEFAULT '',
  website                TEXT NOT NULL DEFAULT '',
  stripe_account_id      TEXT UNIQUE,
  stripe_charges_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vendors_category_id_idx ON vendors(category_id);

CREATE TABLE services (
  id          BIGSERIAL PRIMARY KEY,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INT  NOT NULL CHECK (price_cents >= 50),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX services_vendor_id_idx ON services(vendor_id);

-- CRM: every row is scoped to exactly one vendor.
CREATE TABLE crm_contacts (
  id           BIGSERIAL PRIMARY KEY,
  vendor_id    BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  stage        TEXT NOT NULL DEFAULT 'lead'
               CHECK (stage IN ('lead', 'contacted', 'proposal', 'booked', 'completed', 'lost')),
  source       TEXT NOT NULL DEFAULT 'manual',
  event_type   TEXT NOT NULL DEFAULT '',
  event_date   DATE,
  budget_cents INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_contacts_vendor_stage_idx ON crm_contacts(vendor_id, stage);
CREATE UNIQUE INDEX crm_contacts_vendor_email_uniq ON crm_contacts(vendor_id, lower(email)) WHERE email <> '';

CREATE TABLE crm_activities (
  id         BIGSERIAL PRIMARY KEY,
  vendor_id  BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL
             CHECK (kind IN ('note', 'call', 'email', 'meeting', 'inquiry', 'booking', 'payment', 'stage_change')),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_activities_contact_idx ON crm_activities(contact_id, created_at DESC);

CREATE TABLE crm_tasks (
  id         BIGSERIAL PRIMARY KEY,
  vendor_id  BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  contact_id BIGINT REFERENCES crm_contacts(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  due_date   DATE,
  done       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_tasks_vendor_idx ON crm_tasks(vendor_id, done, due_date);

CREATE TABLE bookings (
  id                         BIGSERIAL PRIMARY KEY,
  vendor_id                  BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  service_id                 BIGINT REFERENCES services(id) ON DELETE SET NULL,
  contact_id                 BIGINT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  public_token               TEXT NOT NULL UNIQUE, -- unguessable id for the customer's receipt page
  service_title              TEXT NOT NULL,
  customer_name              TEXT NOT NULL,
  customer_email             TEXT NOT NULL,
  customer_phone             TEXT NOT NULL DEFAULT '',
  event_date                 DATE NOT NULL,
  notes                      TEXT NOT NULL DEFAULT '',
  amount_cents               INT NOT NULL,
  platform_fee_cents         INT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'pending_payment'
                             CHECK (status IN ('pending_payment', 'paid', 'completed', 'cancelled')),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id   TEXT,
  stripe_destination         TEXT, -- connected account that received the funds, if any
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                    TIMESTAMPTZ
);
CREATE INDEX bookings_vendor_idx ON bookings(vendor_id, created_at DESC);
