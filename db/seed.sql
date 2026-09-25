-- ===================================================================
-- THE VENDOR CATEGORIES
--
-- 12 categories. Safe to run this file as many times as you like:
-- "on conflict do nothing" means it skips any that already exist.
-- ===================================================================

insert into categories (slug, name, description) values
  ('photography',    'Photography',        'Photographers for weddings, parties and corporate events'),
  ('videography',    'Videography',         'Video and film crews, highlight reels, live streaming'),
  ('catering',       'Catering',            'Food and drink service, buffets, plated dinners, bartenders'),
  ('dj-music',       'DJ & Music',          'DJs, live bands, solo musicians, sound systems'),
  ('venues',         'Venues',              'Halls, barns, rooftops, gardens and private rooms'),
  ('florists',       'Florists',            'Bouquets, centrepieces, arches and installations'),
  ('event-planners', 'Event Planners',      'Full planning and day-of coordination'),
  ('decor-rentals',  'Decor & Rentals',     'Tables, chairs, linens, lighting, marquees, staging'),
  ('cakes-desserts', 'Cakes & Desserts',    'Wedding cakes, dessert tables, bakeries'),
  ('hair-makeup',    'Hair & Makeup',       'Bridal hair, makeup artists, grooming'),
  ('transportation', 'Transportation',      'Limos, classic cars, shuttles, party buses'),
  ('entertainment',  'Entertainment',       'Magicians, dancers, photo booths, kids entertainers')
on conflict (slug) do nothing;
