INSERT INTO categories (slug, name, description, sort_order) VALUES
  ('photography',    'Photography',          'Wedding, portrait and event photographers',    1),
  ('videography',    'Videography',          'Event films, highlight reels and drone video', 2),
  ('catering',       'Catering',             'Full-service catering, food trucks and bars',  3),
  ('dj',             'DJs',                  'DJs and MCs for parties and receptions',       4),
  ('live-music',     'Live Music',           'Bands, soloists and string quartets',          5),
  ('venues',         'Venues',               'Halls, gardens, rooftops and ballrooms',       6),
  ('florists',       'Florists',             'Bouquets, centerpieces and floral installs',   7),
  ('planners',       'Event Planners',       'Full planning and day-of coordination',        8),
  ('decor-rentals',  'Decor & Rentals',      'Tables, linens, tents and decor',              9),
  ('hair-makeup',    'Hair & Makeup',        'Bridal and event hair and makeup artists',     10),
  ('cakes-desserts', 'Cakes & Desserts',     'Custom cakes, dessert tables and bakers',      11),
  ('officiants',     'Officiants',           'Wedding officiants and ceremony leaders',      12),
  ('lighting-av',    'Lighting & AV',        'Stage lighting, sound and projection',         13),
  ('photo-booths',   'Photo Booths',         'Photo booth and 360-booth rentals',            14),
  ('transportation', 'Transportation',       'Limos, shuttles and vintage cars',             15)
ON CONFLICT (slug) DO NOTHING;
