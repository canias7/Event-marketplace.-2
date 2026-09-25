/* ===================================================================
   STOPS ONE BROKEN PAGE FROM KILLING THE WHOLE APP.

   Every page in this app talks to the database, which means every page
   has to wait for an answer. If the database refuses something, that
   refusal has to be caught and turned into an error page.

   If it is NOT caught, Node shuts the entire program down - so one bad
   web request would log out every vendor and take the site offline.

   Wrapping a page in handle() sends any such failure to the error page
   in server.js instead. Every page that waits on the database must be
   wrapped in it.
   =================================================================== */

const handle = (page) => (req, res, next) =>
  Promise.resolve(page(req, res, next)).catch(next);

module.exports = { handle };
