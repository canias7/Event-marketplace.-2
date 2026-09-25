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
run_app() { PORT=$PORT LOCAL_DB_DIR="$WORK/db" DATABASE_URL= STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY= "$@"; }

# Started as a plain command with the settings in front, NOT through a
# shell function - otherwise $! is the wrapper's id and we would later
# "stop" the wrapper while the app kept running.
start_server() {
  PORT=$PORT LOCAL_DB_DIR="$WORK/db" DATABASE_URL= STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY= \
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

echo "Starting the app on port $PORT with a throwaway database..."
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
check "price shows as dollars"          "$(body -b $WORK/v.jar $BASE/vendor | grep -c '1,500.00')" "1"
check "email was stored lowercase"      "$(body -b $WORK/v.jar $BASE/vendor | grep -c 'sam@goldenhour.com')" "1"
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

# The local database can only be opened by one program at a time, so this
# must be refused while the app is running - quietly losing the new admin
# would be much worse than an error.
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
check "browse now shows 26 vendors"     "$(body $BASE/browse | grep -oE '[0-9]+ vendors')" "26 vendors"
check "every category has a vendor"     "$(body $BASE/ | grep -c '<td>0</td>')" "0"
check "a demo vendor can log in"        "$(login $WORK/d.jar 'golden.hour.photography@example.com' 'demo1234')" "302"
check "  ...and sees their dashboard"   "$(code -b $WORK/d.jar $BASE/vendor)" "200"

echo
echo "13. THE APP NEVER CRASHED"
check "no unwrapped page failures" "$(grep -c 'UNHANDLED PROBLEM' $WORK/server.log || true)" "0"
check "the app is still answering"  "$(code $BASE/)" "200"

echo
echo "================================"
echo " PASSED: $PASS    FAILED: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ] || exit 1
