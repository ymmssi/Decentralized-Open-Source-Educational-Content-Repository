;; Content Verification Smart Contract
;; Manages community-driven verification of educational content.
;; Includes voting, stake-based incentives, dispute resolution, and verification status updates.

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-HASH u101)
(define-constant ERR-ALREADY-VERIFIED u102)
(define-constant ERR-VOTING-CLOSED u103)
(define-constant ERR-INSUFFICIENT-STAKE u104)
(define-constant ERR-INVALID-VOTE u105)
(define-constant ERR-INVALID-DISPUTE u106)
(define-constant ERR-NOT-REGISTERED u107)
(define-constant ERR-MAX-VOTERS u108)
(define-constant ERR-INVALID-THRESHOLD u109)
(define-constant ERR-ALREADY-VOTED u110)

(define-constant MAX-VOTERS u50)
(define-constant MIN-STAKE u1000) ;; Minimum stake in micro-STX
(define-constant VOTING_PERIOD u1440) ;; ~10 days (1440 blocks)
(define-constant MAX-DISPUTE-NOTE-LEN u200)
(define-constant MAX-VERIFICATION-NOTE-LEN u200)
(define-constant VERIFICATION-THRESHOLD u70) ;; 70% approval required

;; Data Maps
(define-map verification-queue
  { content-hash: (buff 32) }
  {
    status: (string-utf8 20), ;; "pending", "verified", "rejected"
    start-height: uint,
    yes-votes: uint,
    no-votes: uint,
    total-stake: uint,
    voters: (list 50 principal)
  }
)

(define-map votes
  { content-hash: (buff 32), voter: principal }
  {
    vote: bool, ;; true = yes, false = no
    stake: uint,
    timestamp: uint
  }
)

(define-map disputes
  { content-hash: (buff 32), disputer: principal }
  {
    note: (string-utf8 200),
    timestamp: uint,
    resolved: bool
  }
)

(define-map verification-history
  { content-hash: (buff 32), verification-id: uint }
  {
    status: (string-utf8 20),
    note: (string-utf8 200),
    timestamp: uint,
    verifier-count: uint,
    total-stake: uint
  }
)

;; Data Variables
(define-data-var verification-id-counter uint u0)

;; Private Functions
(define-private (validate-vote (vote bool))
  (is-eq vote true))

(define-private (is-content-registered (content-hash (buff 32)))
  (is-some (contract-call? .content-registry get-content-details content-hash)))

(define-private (is-voting-open (content-hash (buff 32)))
  (let ((queue-entry (map-get? verification-queue { content-hash: content-hash })))
    (if (is-none queue-entry)
      false
      (let ((entry (unwrap-panic queue-entry)))
        (and
          (is-eq (get status entry) "pending")
          (< (- block-height (get start-height entry)) VOTING_PERIOD)
        )
      )
    )
  )
)

(define-private (calculate-verification-result (yes-votes uint) (no-votes uint))
  (let ((total-votes (+ yes-votes no-votes)))
    (if (is-eq total-votes u0)
      false
      (>= (/ (* yes-votes u100) total-votes) VERIFICATION-THRESHOLD)
    )
  )
)

;; Public Functions
(define-public (add-to-verification-queue (content-hash (buff 32)))
  (let
    (
      (queue-entry (map-get? verification-queue { content-hash: content-hash }))
    )
    (asserts! (is-content-registered content-hash) (err ERR-NOT-REGISTERED))
    (asserts! (is-none queue-entry) (err ERR-ALREADY-VERIFIED))
    (map-set verification-queue
      { content-hash: content-hash }
      {
        status: "pending",
        start-height: block-height,
        yes-votes: u0,
        no-votes: u0,
        total-stake: u0,
        voters: (list )
      }
    )
    (ok true)
  )
)

(define-public (vote-on-content (content-hash (buff 32)) (vote bool) (stake uint))
  (let
    (
      (queue-entry (unwrap! (map-get? verification-queue { content-hash: content-hash }) (err ERR-NOT-REGISTERED)))
      (voter-entry (map-get? votes { content-hash: content-hash, voter: tx-sender }))
    )
    (asserts! (is-voting-open content-hash) (err ERR-VOTING-CLOSED))
    (asserts! (is-none voter-entry) (err ERR-ALREADY-VOTED))
    (asserts! (>= stake MIN-STAKE) (err ERR-INSUFFICIENT-STAKE))
    (asserts! (validate-vote vote) (err ERR-INVALID-VOTE))
    (asserts! (< (len (get voters queue-entry)) MAX-VOTERS) (err ERR-MAX-VOTERS))
    (try! (stx-transfer? stake tx-sender (as-contract tx-sender)))
    (map-set votes
      { content-hash: content-hash, voter: tx-sender }
      {
        vote: vote,
        stake: stake,
        timestamp: block-height
      }
    )
    (map-set verification-queue
      { content-hash: content-hash }
      (merge queue-entry
        {
          yes-votes: (if vote (+ (get yes-votes queue-entry) u1) (get yes-votes queue-entry)),
          no-votes: (if vote (get no-votes queue-entry) (+ (get no-votes queue-entry) u1)),
          total-stake: (+ (get total-stake queue-entry) stake),
          voters: (unwrap! (as-max-len? (append (get voters queue-entry) tx-sender) u50) (err ERR-MAX-VOTERS))
        }
      )
    )
    (ok true)
  )
)

(define-public (finalize-verification (content-hash (buff 32)) (note (string-utf8 200)))
  (let
    (
      (queue-entry (unwrap! (map-get? verification-queue { content-hash: content-hash }) (err ERR-NOT-REGISTERED)))
      (is-admin (contract-call? .governance is-admin tx-sender))
    )
    (asserts! is-admin (err ERR-UNAUTHORIZED))
    (asserts! (not (is-voting-open content-hash)) (err ERR-VOTING-CLOSED))
    (asserts! (<= (len note) MAX-VERIFICATION-NOTE-LEN) (err ERR-INVALID-DISPUTE))
    (let
      (
        (result (calculate-verification-result (get yes-votes queue-entry) (get no-votes queue-entry)))
        (new-status (if result "verified" "rejected"))
        (ver-id (var-get verification-id-counter))
      )
      (map-set verification-queue
        { content-hash: content-hash }
        (merge queue-entry { status: new-status })
      )
      (map-set verification-history
        { content-hash: content-hash, verification-id: ver-id }
        {
          status: new-status,
          note: note,
          timestamp: block-height,
          verifier-count: (+ (get yes-votes queue-entry) (get no-votes queue-entry)),
          total-stake: (get total-stake queue-entry)
        }
      )
      (var-set verification-id-counter (+ ver-id u1))
      (try! (contract-call? .content-registry update-content-status content-hash new-status true))
      (ok true)
    )
  )
)

(define-public (raise-dispute (content-hash (buff 32)) (note (string-utf8 200)))
  (let
    (
      (queue-entry (unwrap! (map-get? verification-queue { content-hash: content-hash }) (err ERR-NOT-REGISTERED)))
    )
    (asserts! (is-eq (get status queue-entry) "verified") (err ERR-INVALID-DISPUTE))
    (asserts! (<= (len note) MAX-DISPUTE-NOTE-LEN) (err ERR-INVALID-DISPUTE))
    (map-set disputes
      { content-hash: content-hash, disputer: tx-sender }
      {
        note: note,
        timestamp: block-height,
        resolved: false
      }
    )
    (ok true)
  )
)

(define-public (resolve-dispute (content-hash (buff 32)) (disputer principal) (resolve-status bool) (note (string-utf8 200)))
  (let
    (
      (dispute-entry (unwrap! (map-get? disputes { content-hash: content-hash, disputer: disputer }) (err ERR-INVALID-DISPUTE)))
      (is-admin (contract-call? .governance is-admin tx-sender))
    )
    (asserts! is-admin (err ERR-UNAUTHORIZED))
    (asserts! (not (get resolved dispute-entry)) (err ERR-INVALID-DISPUTE))
    (asserts! (<= (len note) MAX-VERIFICATION-NOTE-LEN) (err ERR-INVALID-DISPUTE))
    (map-set disputes
      { content-hash: content-hash, disputer: disputer }
      (merge dispute-entry { resolved: true })
    )
    (if resolve-status
      (try! (contract-call? .content-registry update-content-status content-hash "pending" false))
      (ok true)
    )
  )
)

;; Read-Only Functions
(define-read-only (get-verification-status (content-hash (buff 32)))
  (map-get? verification-queue { content-hash: content-hash })
)

(define-read-only (get-vote-details (content-hash (buff 32)) (voter principal))
  (map-get? votes { content-hash: content-hash, voter: voter })
)

(define-read-only (get-dispute-details (content-hash (buff 32)) (disputer principal))
  (map-get? disputes { content-hash: content-hash, disputer: disputer })
)

(define-read-only (get-verification-history (content-hash (buff 32)) (verification-id uint))
  (map-get? verification-history { content-hash: content-hash, verification-id: verification-id })
)