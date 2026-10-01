import type { NeonQueryFunction } from '@neondatabase/serverless';

export type Sql = NeonQueryFunction<false, false>;

export type Bindings = {
  DATABASE_URL: string;
  /** Must be a Stripe *test* key (sk_test_... or rk_test_...). Live keys are refused. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  /** Platform commission in basis points; 1000 = 10%. */
  PLATFORM_FEE_BPS?: string;
};

export type SessionUser = { id: number; email: string };

export type Vendor = {
  id: number;
  user_id: number;
  category_id: number;
  business_name: string;
  slug: string;
  city: string;
  description: string;
  phone: string;
  website: string;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    sql: Sql;
    user: SessionUser | null;
    vendor: Vendor | null;
  };
};

/** Context variables after requireVendor has run. */
export type VendorEnv = {
  Bindings: Bindings;
  Variables: { sql: Sql; user: SessionUser; vendor: Vendor };
};
