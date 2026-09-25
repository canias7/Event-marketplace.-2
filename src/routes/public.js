/* ===================================================================
   PUBLIC PAGES - anyone can see these, no login.
   =================================================================== */

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  // Every category, with a count of how many visible vendors it has.
  const categories = await db.query(
    `select c.id, c.slug, c.name,
            count(v.id) filter (where v.is_active) ::int as vendor_count
       from categories c
       left join vendors v on v.category_id = c.id
      group by c.id
      order by c.name`
  );
  res.render('home', { title: 'Find event vendors', categories: categories.rows });
});

/* Placeholder until the browse pages are built. */
router.get('/browse', (req, res) => res.redirect('/'));

module.exports = router;
