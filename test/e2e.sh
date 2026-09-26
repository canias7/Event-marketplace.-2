#!/usr/bin/env bash
# ===================================================================
# END TO END TEST
#
# Starts the app on a spare port with a throwaway database, clicks
# through every page the way a browser would, and checks what comes
# back. Tidies up after itself.
#
# Run with: npm test
# ===================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=3999
BASE="http://localhost:$PORT"
WORK="$(mktemp -d)"
PASS=0; FAIL=0

# Two ways to run these tests:
#   npm test                          -> the built-in local database
#   TEST_DATABASE_URL=... npm test    -> a real Postgres server, e.g. Neon
# The app is identical either way. A few things genuinely differ, and the
# tests below say so where they do.
DB_URL="${TEST_DATABASE_URL:-}"
if [ -n "$DB_URL" ]; then
  WHERE="a real Postgres server ($(echo "$DB_URL" | sed -E 's|.*@([^/?]+).*|\1|'))"
else
  WHERE="the built-in local database"
fi

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "${WORK:-}" ] && [ -d "$WORK" ] && rm -rf "${WORK:?}"
}
trap cleanup EXIT

check() {
  if [ "$2" = "$3" ]; then printf '  PASS  %s\n' "$1"; PASS=$((PASS+1))
  else printf '  FAIL  %s\n          got:    %s\n          wanted: %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}

# Helpers. "where did it send us" strips the http://host part so we can
# compare against a plain path.
code()  { curl -s -o /dev/null -w '%{http_code}'    "$@"; }
whereto(){ curl -s -o /dev/null -w '%{redirect_url}' "$@" | sed "s|^$BASE||"; }
body()  { curl -s "$@"; }
errmsg(){ curl -s "$@" | grep -o 'class="error">[^<]*' | sed 's/class="error">//'; }

# The app always runs with the throwaway database and no Stripe keys.
# A fixed SESSION_SECRET, because a random one changes on every restart and
# would log everyone out regardless of where logins are stored.
SECRET=testing-only-fixed-secret-0123456789abcdef

run_app() { PORT=$PORT LOCAL_DB_DIR="$WORK/db" DATABASE_URL="$DB_URL" SESSION_SECRET="$SECRET" STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY= "$@"; }

# Started as a plain command with the settings in front, NOT through a
# shell function - otherwise $! is the wrapper's id and we would later
# "stop" the wrapper while the app kept running.
start_server() {
  PORT=$PORT LOCAL_DB_DIR="$WORK/db" DATABASE_URL="$DB_URL" SESSION_SECRET="$SECRET" STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY= \
    node src/server.js >> "$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "SERVER DIED ON STARTUP:"; tail -20 "$WORK/server.log"; exit 1; }
    curl -s -o /dev/null "$BASE/" && return 0
    sleep 0.5
  done
  echo "SERVER NEVER ANSWERED:"; tail -20 "$WORK/server.log"; exit 1
}

stop_server() {
  [ -z "${SERVER_PID:-}" ] && return 0
  kill "$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 40); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
  wait "$SERVER_PID" 2>/dev/null
  if curl -s -o /dev/null "$BASE/"; then
    echo "SOMETHING IS STILL LISTENING ON $PORT - the test cannot trust its results"; exit 1
  fi
  SERVER_PID=""
}

# Refuse to run if anything is already answering on our port - it would be
# a different app with a different database, and every result would be a lie.
if curl -s -o /dev/null -m 2 "$BASE/"; then
  echo "SOMETHING IS ALREADY RUNNING ON PORT $PORT."
  echo "Stop it first, then run the tests again."
  echo "Find it with:  ps -eo pid,args | grep 'node src/server'"
  exit 1
fi

# A real server keeps whatever was there last time, so wipe it first.
# The local database is a fresh folder each run and needs no wiping.
if [ -n "$DB_URL" ]; then
  echo "Emptying the test database first..."
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f db/reset.sql || { echo "could not reach $DB_URL"; exit 1; }
fi

echo "Testing against $WHERE"
echo "Starting the app on port $PORT..."
start_server
echo

echo "1. PUBLIC PAGES"
check "home page loads"                "$(code $BASE/)"              "200"
check "home lists all 12 categories"   "$(body $BASE/ | grep -c '/browse/')" "12"
check "vendor signup form loads"       "$(code $BASE/vendor/signup)" "200"
check "vendor login form loads"        "$(code $BASE/vendor/login)"  "200"
check "admin login form loads"         "$(code $BASE/admin/login)"   "200"
check "unknown page gives 404"         "$(code $BASE/no-such-page)"  "404"
check "startup says pretend payments"  "$(grep -c 'pretend mode' $WORK/server.log)" "1"

echo
echo "1b. THE DATABASE SET ITSELF UP"
check "all 5 migrations applied"       "$(grep -c 'applied 00' $WORK/server.log)" "5"
check "they ran in number order"       "$(grep -oE 'applied 00[0-9]' $WORK/server.log | tr -d '\n')" "applied 001applied 002applied 003applied 004applied 005"
check "the health page says ok"        "$(body $BASE/healthz)" "ok"
check "  ...and returns nothing else"  "$(body $BASE/healthz | wc -c | tr -d ' ')" "2"

echo
echo "2. PAGES THAT NEED A LOGIN ARE ACTUALLY LOCKED"
check "vendor dashboard is blocked"    "$(whereto $BASE/vendor)" "/vendor/login"
check "admin dashboard is blocked"     "$(whereto $BASE/admin)"  "/admin/login"

echo
echo "3. VENDOR SIGNUP"
check "signup succeeds" "$(code -c $WORK/v.jar -X POST $BASE/vendor/signup \
  -d 'businessName=Golden Hour Photography' -d 'categoryId=1' -d 'city=Austin' \
  -d 'phone=512-555-0100' -d 'priceFrom=1500' -d 'description=Weddings' \
  -d 'email=Sam@GoldenHour.com' -d 'password=supersecret123')" "302"
check "logged in straight after signup" "$(code -b $WORK/v.jar $BASE/vendor)" "200"
check "dashboard shows the business"    "$(body -b $WORK/v.jar $BASE/vendor | grep -c 'Golden Hour Photography')" "1"
check "account page shows the price"    "$(body -b $WORK/v.jar $BASE/vendor/account | grep -c '1,500.00')" "1"
check "email was stored lowercase"      "$(body -b $WORK/v.jar $BASE/vendor/account | grep -c 'sam@goldenhour.com')" "1"
check "vendor is NOT also an admin"     "$(whereto -b $WORK/v.jar $BASE/admin)" "/admin/login"

echo
echo "4. SIGNUP REFUSES BAD INPUT"
signup() { errmsg -X POST $BASE/vendor/signup -d "businessName=$1" -d "categoryId=$2" -d "email=$3" -d "password=$4"; }
check "duplicate email"   "$(signup 'Dupe'    1   'sam@goldenhour.com' 'supersecret123')" "An account with that email already exists."
check "password too short" "$(signup 'Shorty'  1   'a@example.com'      'abc')"            "Your password must be at least 8 characters."
check "malformed email"    "$(signup 'BadMail' 1   'not-an-email'       'supersecret123')" "That does not look like an email address."
check "category made up"   "$(signup 'NoCat'   999 'b@example.com'      'supersecret123')" "Please choose a category."
check "no business name"   "$(signup ''        1   'c@example.com'      'supersecret123')" "Please enter your business name."

echo
echo "5. LOGGING IN AND OUT"
login() { code -c "$1" -X POST $BASE/vendor/login -d "email=$2" -d "password=$3"; }
check "wrong password refused"        "$(login $WORK/x.jar 'sam@goldenhour.com' 'WRONGPASSWORD')" "401"
check "wrong password: vague message" "$(body -X POST $BASE/vendor/login -d 'email=sam@goldenhour.com' -d 'password=NOPE' | grep -c 'Email or password is incorrect')" "1"
check "unknown email: SAME message"   "$(body -X POST $BASE/vendor/login -d 'email=ghost@nowhere.com' -d 'password=NOPE' | grep -c 'Email or password is incorrect')" "1"
check "right password accepted"       "$(login $WORK/v2.jar 'sam@goldenhour.com' 'supersecret123')" "302"
check "  ...and opens the dashboard"  "$(code -b $WORK/v2.jar $BASE/vendor)" "200"
check "email is case-insensitive"     "$(login $WORK/v3.jar 'SAM@GOLDENHOUR.COM' 'supersecret123')" "302"
curl -s -o /dev/null -b $WORK/v2.jar -c $WORK/v2.jar -X POST $BASE/vendor/logout
check "logout locks it again"          "$(whereto -b $WORK/v2.jar $BASE/vendor)" "/vendor/login"

echo
echo "6. PASSWORD GUESSING IS BLOCKED"
curl -s -o /dev/null -X POST $BASE/vendor/signup -d 'businessName=Target' -d 'categoryId=2' \
  -d 'email=target@example.com' -d 'password=correcthorse1'
for _ in $(seq 1 8); do
  curl -s -o /dev/null -X POST $BASE/vendor/login -d 'email=target@example.com' -d 'password=guessing'
done
check "locked out after 8 tries" "$(body -X POST $BASE/vendor/login -d 'email=target@example.com' -d 'password=guessing' | grep -c 'Too many failed attempts')" "1"
check "even the RIGHT password is held off" "$(body -X POST $BASE/vendor/login -d 'email=target@example.com' -d 'password=correcthorse1' | grep -c 'Too many failed attempts')" "1"
check "a different account is unaffected" "$(login $WORK/v4.jar 'sam@goldenhour.com' 'supersecret123')" "302"

echo
echo "7. ADMIN"
check "login page says how to make an admin" "$(body $BASE/admin/login | grep -c 'No admin account exists yet')" "1"

if [ -z "$DB_URL" ]; then
  # The local database is built into the program, so only one thing can open
  # it. This MUST be refused - quietly losing the new admin would be far
  # worse than an error message.
  run_app node scripts/create-admin.js owner@eventvendora.com adminpass123 > "$WORK/blocked.log" 2>&1
  check "create-admin refuses while the app is running" "$(grep -c 'CANNOT OPEN THE LOCAL DATABASE' $WORK/blocked.log)" "1"
  check "  ...and says how to fix it"                   "$(grep -c 'press Ctrl+C' $WORK/blocked.log)" "1"
  check "  ...and no admin was created"                 "$(body $BASE/admin/login | grep -c 'No admin account exists yet')" "1"

  echo "   (stopping the app, creating the admin, starting it again)"
  stop_server
  run_app node scripts/create-admin.js owner@eventvendora.com adminpass123 > "$WORK/admin.log" 2>&1
  check "create-admin works once the app is stopped" "$(grep -c 'Admin account created' $WORK/admin.log)" "1"
  check "the lock note was tidied up"                "$([ -e "$WORK/db.in-use-by-pid" ] && echo present || echo gone)" "gone"
  start_server
else
  # A real server takes many connections at once, so there is nothing to
  # stop and nothing to wait for. This is one of the reasons to use Neon.
  run_app node scripts/create-admin.js owner@eventvendora.com adminpass123 > "$WORK/admin.log" 2>&1
  check "create-admin works WHILE the app is running" "$(grep -c 'Admin account created' $WORK/admin.log)" "1"
  check "  ...no need to stop anything"               "$(code $BASE/)" "200"
fi

check "admin can log in"             "$(code -c $WORK/a.jar -X POST $BASE/admin/login -d 'email=owner@eventvendora.com' -d 'password=adminpass123')" "302"
check "admin dashboard opens"        "$(code -b $WORK/a.jar $BASE/admin)" "200"
check "admin is NOT also a vendor"   "$(whereto -b $WORK/a.jar $BASE/vendor)" "/vendor/login"
check "wrong admin password refused" "$(code -X POST $BASE/admin/login -d 'email=owner@eventvendora.com' -d 'password=nope')" "401"

echo
echo "8. DATA SURVIVED THE RESTART"
check "admin sees both vendors"    "$(body -b $WORK/a.jar $BASE/admin | grep -c '<th>Vendors</th><td>2</td>')" "1"
check "the first vendor is listed" "$(body -b $WORK/a.jar $BASE/admin | grep -c 'Golden Hour Photography')" "1"
check "that vendor can still log in" "$(login $WORK/v5.jar 'sam@goldenhour.com' 'supersecret123')" "302"

echo
echo "9. CUSTOMERS CAN BROWSE"
check "browse-everything page loads"      "$(code $BASE/browse)" "200"
check "  ...and lists the vendor"         "$(body $BASE/browse | grep -c 'Golden Hour Photography')" "1"
check "a category page loads"             "$(code $BASE/browse/photography)" "200"
check "  ...and lists the vendor"         "$(body $BASE/browse/photography | grep -c 'Golden Hour Photography')" "1"
check "an empty category says so"         "$(body $BASE/browse/catering | grep -c 'No vendors here yet')" "1"
check "a made-up category is 404"         "$(code $BASE/browse/not-a-real-category)" "404"
check "a vendor profile loads"            "$(code $BASE/vendors/1)" "200"
check "  ...and offers the booking form"  "$(body $BASE/vendors/1 | grep -c 'Request a booking')" "1"
check "a missing vendor is 404"           "$(code $BASE/vendors/99999)" "404"
check "a nonsense vendor id is 404"       "$(code $BASE/vendors/abc)" "404"
check "vendor emails are NOT public"      "$(body $BASE/vendors/1 | grep -c 'goldenhour.com')" "0"

echo
echo "10. SENDING A BOOKING REQUEST"
check "a good request is accepted" "$(code -c $WORK/cust.jar -X POST $BASE/vendors/1/request \
  -d 'name=Avery Chen' -d 'email=Avery@Example.com' -d 'phone=512-555-0199' \
  -d 'eventDate=2099-05-15' -d 'eventType=Wedding' -d 'guestCount=95' \
  -d 'details=Full day coverage, two shooters.')" "302"
check "  ...and confirms it"            "$(body -b $WORK/cust.jar $BASE/request-sent | grep -c '<h1>Request sent</h1>')" "1"
check "  ...naming the right vendor"    "$(body -b $WORK/cust.jar $BASE/request-sent | grep -c 'Golden Hour Photography')" "1"
check "the receipt page needs a session" "$(whereto $BASE/request-sent)" "/"
check "it reached the vendor CRM"       "$(body -b $WORK/a.jar $BASE/admin | grep -c '<th>Bookings</th><td>1</td>')" "1"
check "the customer was recorded"       "$(body -b $WORK/a.jar $BASE/admin | grep -c '<th>Customers</th><td>1</td>')" "1"

request() { curl -s -X POST $BASE/vendors/1/request -d "name=$1" -d "email=$2" -d "eventDate=$3" -d "details=$4" -d "guestCount=${5:-}" | grep -o 'class="error">[^<]*' | sed 's/class="error">//'; }
check "no name refused"        "$(request ''      'a@b.com' '2099-05-15' 'stuff')" "Please enter your name."
check "bad email refused"      "$(request 'Avery' 'nope'    '2099-05-15' 'stuff')" "That does not look like an email address."
check "past date refused"      "$(request 'Avery' 'a@b.com' '2020-01-01' 'stuff')" "That date has already passed."
check "31 February refused"    "$(request 'Avery' 'a@b.com' '2099-02-31' 'stuff')" "That date does not exist. Please check the day and month."
check "no details refused"     "$(request 'Avery' 'a@b.com' '2099-05-15' '')"      "Please tell the vendor what you need."
check "worded guest count refused" "$(request 'Avery' 'a@b.com' '2099-05-15' 'stuff' 'about eighty')" "Guest count must be a whole number."
check "a blank date is allowed" "$(request 'Avery' 'a@b.com' ''          'stuff')" ""
check "requests to a missing vendor 404" "$(code -X POST $BASE/vendors/99999/request -d 'name=A' -d 'email=a@b.com' -d 'details=x')" "404"

echo
echo "11. A BAD REQUEST CANNOT TAKE THE SITE DOWN"
# A null byte is something Postgres genuinely refuses to store. Before
# handle() existed this killed the whole app, logging out every vendor.
check "database error gives an error page" "$(code -X POST $BASE/vendors/1/request -d 'name=A' -d 'email=a@b.com' -d 'details=x' -d 'eventType=bad%00type')" "500"
check "  ...and the app is still serving"  "$(code $BASE/)" "200"
check "  ...and logins still work"         "$(login $WORK/v6.jar 'sam@goldenhour.com' 'supersecret123')" "302"

echo
echo "12. DEMO DATA"
echo "   (stopping the app to load it, then starting again)"
stop_server
run_app node scripts/demo-data.js --force > "$WORK/demo.log" 2>&1
check "demo data loaded"        "$(grep -c '24 vendors' $WORK/demo.log)" "1"
check "it printed a login"      "$(grep -c 'password: demo1234' $WORK/demo.log)" "1"
start_server

# This is the clearest difference between the two databases. Logins are
# kept in memory locally, so a restart forgets them. On a real server they
# are kept in the database, so a restart - or a redeploy - keeps everyone
# logged in.
if [ -z "$DB_URL" ]; then
  check "a restart logs the admin out (in memory)" "$(whereto -b $WORK/a.jar $BASE/admin)" "/admin/login"
  check "  ...and logging in again works"          "$(code -c $WORK/a.jar -X POST $BASE/admin/login -d 'email=owner@eventvendora.com' -d 'password=adminpass123')" "302"
  check "  ...restoring admin access"              "$(code -b $WORK/a.jar $BASE/admin)" "200"
else
  check "logins are kept in the database"      "$(grep -c 'LOGINS: kept in the database' $WORK/server.log)" "2"
check "  ...with a lasting secret"          "$(grep -c 'SESSION_SECRET is not set' $WORK/server.log)" "0"
  check "a restart does NOT log the admin out" "$(code -b $WORK/a.jar $BASE/admin)" "200"
  check "  ...no second login needed"          "$(body -b $WORK/a.jar $BASE/admin | grep -c 'Customers paid in total')" "1"
fi

check "browse now shows 26 vendors"     "$(body $BASE/browse | grep -oE '[0-9]+ vendors')" "26 vendors"
check "every category has a vendor"     "$(body $BASE/ | grep -c '<td>0</td>')" "0"
check "a demo vendor can log in"        "$(login $WORK/d.jar 'golden.hour.photography@example.com' 'demo1234')" "302"
check "  ...and sees their dashboard"   "$(code -b $WORK/d.jar $BASE/vendor)" "200"

echo
echo "13. THE VENDOR CRM"
check "the vendor with a full pipeline logs in" "$(login $WORK/crm.jar 'golden.hour.photography@example.com' 'demo1234')" "302"

# Find lead numbers from the page rather than hard-coding them.
leadid() { body -b "$WORK/crm.jar" "$BASE/vendor?status=$1" | grep -oE '/vendor/leads/[0-9]+' | head -1 | grep -oE '[0-9]+'; }
# Do something to a lead, then read the message it reported back.
crmdo() {
  curl -s -o /dev/null -b $WORK/crm.jar -c $WORK/crm.jar -X POST "$BASE/vendor/leads/$1/$2" -d "$3"
  body -b $WORK/crm.jar "$BASE/vendor/leads/$1" | grep -oE 'class="(ok|error)">[^<]*' | sed -E 's/class="(ok|error)">//'
}

check "the pipeline totals 10 leads"  "$(body -b $WORK/crm.jar $BASE/vendor | grep -c '<b>10</b> All')" "1"
check "2 sit at New"                  "$(body -b $WORK/crm.jar $BASE/vendor | grep -c '<b>2</b> New')" "1"
check "1 sits at Paid"                "$(body -b $WORK/crm.jar $BASE/vendor | grep -c '<b>1</b> Paid')" "1"
check "filtering to New shows 2"      "$(body -b $WORK/crm.jar "$BASE/vendor?status=new" | grep -oE '[0-9]+ leads? shown')" "2 leads shown"
check "filtering to Paid shows 1"     "$(body -b $WORK/crm.jar "$BASE/vendor?status=paid" | grep -oE '[0-9]+ leads? shown')" "1 lead shown"
check "a nonsense filter is ignored"  "$(body -b $WORK/crm.jar "$BASE/vendor?status=nonsense" | grep -oE '[0-9]+ leads? shown')" "10 leads shown"

NEW_LEAD=$(leadid new)
PAID_LEAD=$(leadid paid)
DONE_LEAD=$(leadid completed)
check "found a New lead to work on"   "$([ -n "$NEW_LEAD" ] && echo yes || echo no)" "yes"

check "the lead page opens"           "$(code -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD)" "200"
check "  ...with the customer email"  "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c 'mailto:')" "1"
check "  ...and offers a price box"   "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c 'Send a price')" "1"
check "a missing lead is 404"         "$(code -b $WORK/crm.jar $BASE/vendor/leads/999999)" "404"
check "a nonsense lead id is 404"     "$(code -b $WORK/crm.jar $BASE/vendor/leads/abc)" "404"

echo "   quoting"
check "a quote is accepted"           "$(crmdo $NEW_LEAD quote 'price=2750')" "Quote sent."
check "  ...and the lead moves to Quoted" "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c 'badge quoted')" "1"
check "  ...showing the amount quoted"    "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c '2,750.00')" "1"
check "  ...and pre-filling the price box" "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c 'value="2750.00"')" "1"
check "  ...the 10% fee"                  "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c '275.00')" "1"
check "  ...and what the vendor keeps"    "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c '2,475.00')" "1"
check "dollar signs and commas are ok"    "$(crmdo $NEW_LEAD quote 'price=$2,500.50')" "Quote sent."
check "  ...stored to the exact cent"     "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c '2,500.50')" "1"
check "zero refused"                  "$(crmdo $NEW_LEAD quote 'price=0')" "The price must be more than zero."
check "words refused"                 "$(crmdo $NEW_LEAD quote 'price=about two grand')" "Enter the price as a number, for example 2500 or 2500.00"
check "blank refused"                 "$(crmdo $NEW_LEAD quote 'price=')" "Please enter a price."

echo "   notes"
check "a note is added"               "$(crmdo $NEW_LEAD note 'body=Rang Tuesday, wants a second shooter.')" "Note added."
check "  ...and shows on the lead"    "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c 'wants a second shooter')" "1"
check "a blank note is refused"       "$(crmdo $NEW_LEAD note 'body=   ')" "Please write something in the note."
check "notes are private to the vendor" "$(body $BASE/vendors/3 | grep -c 'second shooter')" "0"

echo "   moving a lead along"
check "it can be marked booked"        "$(crmdo $NEW_LEAD status 'status=booked')" "Moved to Booked."
check "  ...and the price then locks"  "$(crmdo $NEW_LEAD quote 'price=99')" "You cannot change the price of a booked job."

echo "   money safety"
check "a vendor cannot mark a job paid" "$(crmdo $NEW_LEAD status 'status=paid')" "Only a real payment can mark a job as paid."
check "a paid job cannot be cancelled"  "$(crmdo $PAID_LEAD status 'status=cancelled')" "This job has been paid for. It cannot be cancelled here - that needs a refund."
check "a paid job can only be completed" "$(body -b $WORK/crm.jar $BASE/vendor/leads/$PAID_LEAD | grep -c 'Mark completed')" "1"
check "a finished job is locked"        "$(body -b $WORK/crm.jar $BASE/vendor/leads/$DONE_LEAD | grep -c 'This job is finished')" "1"
check "a made-up status is refused"     "$(crmdo $NEW_LEAD status 'status=banana')" "A booked job cannot be moved to that."

echo "   ONE VENDOR MUST NOT SEE ANOTHER'S LEADS"
check "a second vendor logs in"      "$(login $WORK/other.jar 'marlowe.field.photo@example.com' 'demo1234')" "302"
check "their own CRM is empty"       "$(body -b $WORK/other.jar $BASE/vendor | grep -c 'No booking requests yet')" "1"
check "they CANNOT open the lead"    "$(code -b $WORK/other.jar $BASE/vendor/leads/$NEW_LEAD)" "404"
curl -s -o /dev/null -b $WORK/other.jar -c $WORK/other.jar -X POST $BASE/vendor/leads/$NEW_LEAD/quote  -d 'price=1'        >/dev/null
check "  ...cannot re-price it"      "$(body -b $WORK/other.jar $BASE/vendor | grep -oE 'class="error">[^<]*' | sed 's/class="error">//' | head -1)" "That lead was not found."
curl -s -o /dev/null -b $WORK/other.jar -c $WORK/other.jar -X POST $BASE/vendor/leads/$NEW_LEAD/status -d 'status=lost'    >/dev/null
curl -s -o /dev/null -b $WORK/other.jar -c $WORK/other.jar -X POST $BASE/vendor/leads/$NEW_LEAD/note   -d 'body=tampered'  >/dev/null
check "the owner's lead is untouched"   "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c 'badge booked')" "1"
check "  ...price still theirs"          "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c '2,500.50')" "1"
check "  ...and no note was planted"     "$(body -b $WORK/crm.jar $BASE/vendor/leads/$NEW_LEAD | grep -c 'tampered')" "0"

echo "   the account page"
check "account page opens"           "$(code -b $WORK/crm.jar $BASE/vendor/account)" "200"
check "  ...showing their own email" "$(body -b $WORK/crm.jar $BASE/vendor/account | grep -c 'golden.hour.photography@example.com')" "1"

echo
echo "14. PAYING FOR A BOOKING (pretend mode)"

# A fresh customer request, so this section does not depend on earlier ones.
curl -s -o /dev/null -c $WORK/payer.jar -X POST $BASE/vendors/1/request \
  -d 'name=Robin Vale' -d 'email=robin@example.com' -d 'eventDate=2099-08-01' \
  -d 'eventType=Wedding' -d 'guestCount=70' -d 'details=Six hours of coverage.' >/dev/null

PAY_TOKEN=$(body -b $WORK/payer.jar $BASE/request-sent | grep -oE '/booking/[0-9a-f]+' | head -1 | sed 's|/booking/||')
PAY_ID=$(body -b $WORK/payer.jar $BASE/request-sent | grep -oE 'reference is <strong>#[0-9]+' | grep -oE '[0-9]+')

check "the customer gets a private link"   "$([ ${#PAY_TOKEN} -ge 32 ] && echo long-enough || echo "too short: ${#PAY_TOKEN}")" "long-enough"
check "the link opens their booking"       "$(code $BASE/booking/$PAY_TOKEN)" "200"
check "  ...with no login needed"          "$(body $BASE/booking/$PAY_TOKEN | grep -c 'Waiting for the vendor')" "1"
check "  ...saying no price has come yet"  "$(body $BASE/booking/$PAY_TOKEN | grep -c 'has not sent a price yet')" "1"

echo "   the link must be unguessable"
check "a made-up token is 404"          "$(code $BASE/booking/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)" "404"
check "a short token is 404"            "$(code $BASE/booking/abc)" "404"
check "the booking NUMBER is 404"       "$(code $BASE/booking/$PAY_ID)" "404"
check "one character off is 404"        "$(code $BASE/booking/$(printf '%s' "${PAY_TOKEN:0:47}"; [ "${PAY_TOKEN: -1}" = "a" ] && echo b || echo a))" "404"
check "quote marks in the link are 404" "$(code --get --data-urlencode 'x=1' "$BASE/booking/%27%20or%201%3D1")" "404"
check "  ...and the app still works"    "$(code $BASE/)" "200"

echo "   paying too early"
curl -s -o /dev/null -b $WORK/payer.jar -c $WORK/payer.jar -X POST $BASE/booking/$PAY_TOKEN/pay >/dev/null
check "cannot pay before a price exists" "$(body -b $WORK/payer.jar $BASE/booking/$PAY_TOKEN | grep -oE 'class="error">[^<]*' | sed 's/class="error">//')" "This booking cannot be paid yet. The vendor has not sent a price."

echo "   the vendor sends a price"
check "vendor logs in"       "$(login $WORK/payv.jar 'sam@goldenhour.com' 'supersecret123')" "302"
curl -s -o /dev/null -b $WORK/payv.jar -c $WORK/payv.jar -X POST $BASE/vendor/leads/$PAY_ID/quote -d 'price=2600' >/dev/null
check "the quote lands on the lead" "$(body -b $WORK/payv.jar $BASE/vendor/leads/$PAY_ID | grep -c 'badge quoted')" "1"

echo "   the customer pays"
check "they now see the price"        "$(body $BASE/booking/$PAY_TOKEN | grep -c '2,600.00')" "2"
check "they are told it is pretend"   "$(body $BASE/booking/$PAY_TOKEN | grep -c 'Pretend payment')" "1"
check "  ...and no card is asked for" "$(body $BASE/booking/$PAY_TOKEN | grep -ci 'card number')" "0"
curl -s -o /dev/null -b $WORK/payer.jar -c $WORK/payer.jar -X POST $BASE/booking/$PAY_TOKEN/pay >/dev/null
check "the payment goes through"      "$(body -b $WORK/payer.jar $BASE/booking/$PAY_TOKEN | grep -oE 'class="ok">[^<]*' | sed 's/class="ok">//')" "Payment received. Thank you!"
check "  ...and it shows as paid"     "$(body $BASE/booking/$PAY_TOKEN | grep -c 'Paid in full')" "1"
check "  ...with a receipt"           "$(body $BASE/booking/$PAY_TOKEN | grep -c 'pretend payment')" "1"

echo "   paying twice must not work"
curl -s -o /dev/null -b $WORK/payer.jar -c $WORK/payer.jar -X POST $BASE/booking/$PAY_TOKEN/pay >/dev/null
check "a second payment is refused"   "$(body -b $WORK/payer.jar $BASE/booking/$PAY_TOKEN | grep -oE 'class="error">[^<]*' | sed 's/class="error">//')" "This booking has already been paid for."
check "only ONE receipt line exists"  "$(body $BASE/booking/$PAY_TOKEN | grep -c 'pretend payment')" "1"

echo "   what the vendor sees"
check "their lead is now paid"        "$(body -b $WORK/payv.jar $BASE/vendor/leads/$PAY_ID | grep -c 'badge paid')" "1"
check "the fee is 10% of 2600"        "$(body -b $WORK/payv.jar $BASE/vendor/leads/$PAY_ID | grep -c '260.00')" "2"
check "their share is 2340"           "$(body -b $WORK/payv.jar $BASE/vendor/leads/$PAY_ID | grep -c '2,340.00')" "2"
check "they cannot re-price it now"   "$(curl -s -o /dev/null -b $WORK/payv.jar -c $WORK/payv.jar -X POST $BASE/vendor/leads/$PAY_ID/quote -d 'price=1'; body -b $WORK/payv.jar $BASE/vendor/leads/$PAY_ID | grep -oE 'class="error">[^<]*' | sed 's/class="error">//')" "You cannot change the price of a paid job."
check "they CANNOT cancel a paid job" "$(curl -s -o /dev/null -b $WORK/payv.jar -c $WORK/payv.jar -X POST $BASE/vendor/leads/$PAY_ID/status -d 'status=cancelled'; body -b $WORK/payv.jar $BASE/vendor/leads/$PAY_ID | grep -oE 'class="error">[^<]*' | sed 's/class="error">//')" "This job has been paid for. It cannot be cancelled here - that needs a refund."

echo "   what the admin sees"
check "the money section is there"    "$(body -b $WORK/a.jar $BASE/admin | grep -c 'Customers paid in total')" "1"
check "the fee row is there"          "$(body -b $WORK/a.jar $BASE/admin | grep -c 'Your fees from that')" "1"
check "this payment is listed"        "$(body -b $WORK/a.jar $BASE/admin | grep -c '<td>#'$PAY_ID'</td>')" "1"
check "the mode is stated"            "$(body -b $WORK/a.jar $BASE/admin | grep -c 'pretend mode')" "1"

echo
echo "15. THE APP NEVER CRASHED"
check "no unwrapped page failures" "$(grep -c 'UNHANDLED PROBLEM' $WORK/server.log || true)" "0"
check "the app is still answering"  "$(code $BASE/)" "200"

echo
echo "================================"
echo " PASSED: $PASS    FAILED: $FAIL"
echo " against: $WHERE"
echo "================================"
[ "$FAIL" -eq 0 ] || exit 1
