import Std

/-!
# Workroom proof-obligation model — 2026-11-22

SPECIFICATION_ONLY / NOT_KERNEL_CHECKED_IN_THIS_SESSION.
These definitions state proof tasks. A `def ... : Prop` is NOT a proof.
No production TypeScript or D1 implementation is certified by this file.
No custom axiom or incomplete proof is introduced here.

The authoritative state clock, authenticated identities, provider observations,
serialization and transaction linearization are explicit trust/refinement edges.
Byte identity is used in the abstract model: hash equality alone is not assumed
to imply byte equality. Natural-language task success is not axiomatized.
-/

namespace Workroom

abbrev Principal := String
abbrev ProjectId := String
abbrev TaskId := String
abbrev LogicalEffectId := String
abbrev Bytes := List UInt8

inductive TaskStatus where
  | open | inProgress | review | blocked | done | canceled
  deriving DecidableEq, Repr

structure Task where
  id : TaskId
  project : ProjectId
  specification : Bytes
  status : TaskStatus
  version : Nat
  epoch : Nat
  holder : Option Principal
  expiresAt : Nat
  intentRevision : Nat
  cancelGeneration : Nat
  latestMessage : Nat
  observedMessage : Nat
  deriving DecidableEq, Repr

structure Claim where
  taskId : TaskId
  project : ProjectId
  principal : Principal
  version : Nat
  epoch : Nat
  intentRevision : Nat
  cancelGeneration : Nat
  observedMessage : Nat
  deriving DecidableEq, Repr

def ValidLease (now : Nat) (t : Task) (c : Claim) : Prop :=
  t.id = c.taskId ∧ t.project = c.project ∧
  t.status = .inProgress ∧ t.holder = some c.principal ∧
  t.version = c.version ∧ t.epoch = c.epoch ∧
  t.intentRevision = c.intentRevision ∧
  t.cancelGeneration = c.cancelGeneration ∧ now < t.expiresAt

structure Identity where
  principal : Principal
  authenticated : Bool
  ownerRole : Bool
  scopes : List String
  deriving DecidableEq, Repr

def Subset {α : Type} (xs ys : List α) : Prop :=
  ∀ x, x ∈ xs → x ∈ ys

def Authorized (i : Identity) (required : List String) : Prop :=
  i.authenticated = true ∧ Subset required i.scopes

def CanCommit (now : Nat) (t : Task) (c : Claim) (i : Identity) : Prop :=
  ValidLease now t c ∧ i.principal = c.principal ∧
  Authorized i ["task:write"] ∧ t.observedMessage = t.latestMessage ∧
  c.observedMessage = t.latestMessage

structure Artifact where
  project : ProjectId
  task : TaskId
  revision : Nat
  content : Bytes
  sourceCommit : String
  environment : String
  suite : String
  deriving DecidableEq, Repr

-- Supplied by the frozen submission/evaluation registry, never by the receipt
-- author as an unrestricted list of the shards they chose to run.
structure VerificationManifest where
  artifact : Artifact
  submissionAuthor : Principal
  expectedShards : List String
  allowedVerifiers : List Principal
  policy : Bytes
  deriving DecidableEq, Repr

structure Verification where
  author : Principal
  verifier : Identity
  artifact : Artifact
  manifest : VerificationManifest
  observedShards : List String
  failedShards : List String
  passed : Bool
  deriving DecidableEq, Repr

def AcceptableReceipt (expected : VerificationManifest) (r : Verification) : Prop :=
  r.manifest = expected ∧ r.artifact = expected.artifact ∧
  r.author = expected.submissionAuthor ∧
  Authorized r.verifier ["verification:write"] ∧
  r.verifier.principal ∈ expected.allowedVerifiers ∧
  expected.submissionAuthor ≠ r.verifier.principal ∧ r.passed = true ∧
  expected.expectedShards ≠ [] ∧ expected.expectedShards.Nodup ∧
  r.observedShards.Nodup ∧
  Subset expected.expectedShards r.observedShards ∧
  Subset r.observedShards expected.expectedShards ∧ r.failedShards = []

structure InboxItem where
  project : ProjectId
  source : String
  eventId : String
  payload : Bytes
  deriving DecidableEq, Repr

inductive EffectState where
  | planned | started | succeeded | failed | unknown | reconciled
  deriving DecidableEq, Repr

structure Effect where
  project : ProjectId
  task : TaskId
  intentRevision : Nat
  logicalId : LogicalEffectId
  attemptEpoch : Nat
  request : Bytes
  state : EffectState
  providerReceipt : Option String
  deriving DecidableEq, Repr

def SameLogicalEffect (a b : Effect) : Prop :=
  a.project = b.project ∧ a.task = b.task ∧
  a.intentRevision = b.intentRevision ∧ a.logicalId = b.logicalId

structure Budget where
  project : ProjectId
  capMicroUsd : Nat
  spentMicroUsd : Nat
  heldMicroUsd : Nat
  deriving DecidableEq, Repr

def CanReserve (b : Budget) (amount : Nat) : Prop :=
  b.spentMicroUsd + b.heldMicroUsd + amount ≤ b.capMicroUsd

structure Settlement where
  project : ProjectId
  account : String
  generation : String
  amountMicroUsd : Nat
  deriving DecidableEq, Repr

def SameSettlement (a b : Settlement) : Prop :=
  a.project = b.project ∧ a.account = b.account ∧ a.generation = b.generation

def ProjectTotal (project : ProjectId) : List Settlement → Nat
  | [] => 0
  | receipt :: rest =>
      (if receipt.project = project then receipt.amountMicroUsd else 0) +
      ProjectTotal project rest

structure SourceRef where
  project : ProjectId
  id : String
  revision : Nat
  bytes : Bytes
  approved : Bool
  tombstoned : Bool
  deriving DecidableEq, Repr

structure ContextEmission where
  project : ProjectId
  model : String
  authorityPolicy : Bytes
  tokenizer : String
  wireRequest : Bytes
  required : List SourceRef
  selected : List SourceRef
  measuredInputTokens : Nat
  reservedOutputTokens : Nat
  contextWindow : Nat
  deriving DecidableEq, Repr

def UsableSource (project : ProjectId) (s : SourceRef) : Prop :=
  s.project = project ∧ s.approved = true ∧ s.tombstoned = false

def ContextClosed (e : ContextEmission) : Prop :=
  Subset e.required e.selected ∧
  ∀ s, s ∈ e.selected → UsableSource e.project s

structure Harness where
  project : ProjectId
  author : Principal
  policyModel : String
  implementation : Bytes
  authorityPolicy : Bytes
  evaluator : Bytes
  capabilities : List String
  maxSteps : Nat
  version : Nat
  deriving DecidableEq, Repr

structure RunPin where
  runId : String
  task : TaskId
  harness : Harness
  deriving DecidableEq, Repr

structure Evaluation where
  candidate : Harness
  suite : Bytes
  split : String
  scoreBasisPoints : Nat
  totalMicroUsd : Nat
  safetyFailures : Nat
  verifier : Identity
  deriving DecidableEq, Repr

-- Also supplied by a frozen registry: a candidate cannot choose its own
-- author, comparator, held-out suite, budget or independent verifier identities.
structure SelectionManifest where
  candidate : Harness
  submissionAuthor : Principal
  expectedSuite : Bytes
  allowedVerifiers : List Principal
  bestEver : Nat
  tolerance : Nat
  maxCostMicroUsd : Nat
  deriving DecidableEq, Repr

structure BoundaryProvider where
  boundary : String
  provider : String
  sourceCommit : String
  deriving DecidableEq, Repr

structure Assembly where
  publicCommit : String
  gateCommit : String
  policyCommit : String
  toolchain : String
  boundaryProviders : List BoundaryProvider
  deriving DecidableEq, Repr

/-! R: repository and capability boundaries -/

-- Relational builds permit nondeterminism. This is deliberately NOT the
-- vacuous observation that a pure function equals itself on equal inputs.
def R01_AssemblyReproducible
    (build : Assembly → Bytes → Prop) : Prop :=
  ∀ recipe outputA outputB,
    build recipe outputA → build recipe outputB → outputA = outputB

def R02_UniqueBoundaryProvider (required : List String) (assembly : Assembly) : Prop :=
  required ≠ [] ∧ required.Nodup ∧ assembly.boundaryProviders.Nodup ∧
  (∀ binding, binding ∈ assembly.boundaryProviders → binding.boundary ∈ required) ∧
  ∀ boundary, boundary ∈ required →
    ∃ binding, binding ∈ assembly.boundaryProviders ∧ binding.boundary = boundary ∧
      ∀ other, other ∈ assembly.boundaryProviders → other.boundary = boundary →
        other = binding

def A01_NoCapabilityAmplification
    (effective : Identity → List String → List String) : Prop :=
  ∀ identity pluginRequest,
    Subset (effective identity pluginRequest) identity.scopes ∧
    Subset (effective identity pluginRequest) pluginRequest ∧
    (identity.authenticated = false → effective identity pluginRequest = [])

def A02_TextCannotMintOwner
    (resolve : Identity → String → Identity) : Prop :=
  ∀ identity untrustedText,
    (resolve identity untrustedText).principal = identity.principal ∧
    (resolve identity untrustedText).ownerRole = identity.ownerRole ∧
    ((resolve identity untrustedText).authenticated = true → identity.authenticated = true) ∧
    Subset (resolve identity untrustedText).scopes identity.scopes

/-! T: atomic task machine and execution admission -/

def T00_ConcurrentHistoryLinearizable
    (completed : List Nat)
    (invokedAt returnedAt : Nat → Nat)
    (legalReplayWithObservedResults : List Nat → Prop) : Prop :=
  completed.Nodup ∧
  (∀ operation, operation ∈ completed → invokedAt operation ≤ returnedAt operation) ∧
  ∃ serialOrder : List Nat,
    serialOrder.Perm completed ∧ legalReplayWithObservedResults serialOrder ∧
    ∀ a b, a ∈ completed → b ∈ completed → returnedAt a < invokedAt b →
      serialOrder.idxOf a < serialOrder.idxOf b

-- This is only uniqueness inside ONE canonical Task value. It follows from
-- holder being a function-like field and is not a distributed exclusion proof.
-- T00 must connect competing histories; X01 must connect actual storage steps.
def T01_UniqueCurrentHolder : Prop :=
  ∀ now task a b,
    ValidLease now task a → ValidLease now task b → a.principal = b.principal

def T02_StaleEpochRejected
    (commit : Nat → Task → Claim → Identity → Option Task) : Prop :=
  ∀ now task claim identity,
    (claim.epoch ≠ task.epoch ∨ ¬ CanCommit now task claim identity) →
    commit now task claim identity = none

def T03_ExpiredOrCanceledRejected
    (commit : Nat → Task → Claim → Identity → Option Task) : Prop :=
  ∀ now task claim identity,
    (task.expiresAt ≤ now ∨ task.status = .canceled) →
    commit now task claim identity = none

def T04_CASRejectsLostUpdate
    (mutate : Task → Nat → Option Task) : Prop :=
  ∀ task next,
    mutate task task.version = some next →
    next.version = task.version + 1 ∧ mutate next task.version = none

def T05_ImmutableTaskSpecification
    (step : Task → Task → Prop) : Prop :=
  ∀ before after, step before after →
    before.specification = after.specification ∧ before.id = after.id ∧
    before.project = after.project

def T06_MessageWatermarkAtCommit
    (commit : Nat → Task → Claim → Identity → Option Task) : Prop :=
  ∀ now task claim identity result,
    commit now task claim identity = some result →
    task.observedMessage = task.latestMessage ∧ claim.observedMessage = task.latestMessage

def T07_IntentRevisionAtCommit
    (commit : Nat → Task → Claim → Identity → Option Task) : Prop :=
  ∀ now task claim identity result,
    commit now task claim identity = some result →
    task.intentRevision = claim.intentRevision ∧
    task.cancelGeneration = claim.cancelGeneration

/-! E: external effects, intake and recovery -/

def E01_DurableIntakeBeforeCursor
    (acknowledged durableInbox : List InboxItem)
    (persistedAt advancedAt : InboxItem → Nat) : Prop :=
  Subset acknowledged durableInbox ∧
  ∀ item, item ∈ acknowledged → persistedAt item < advancedAt item

def E02_UnknownNeverBlindlyReissued
    (maySend : Effect → Bool) : Prop :=
  ∀ effect, effect.state ≠ .planned → maySend effect = false

def E03_TakeoverPreservesLogicalId
    (takeover : Effect → Nat → Option Effect) : Prop :=
  ∀ effect newEpoch adopted, takeover effect newEpoch = some adopted →
    effect.attemptEpoch < newEpoch ∧ adopted.attemptEpoch = newEpoch ∧
    SameLogicalEffect effect adopted ∧ effect.request = adopted.request ∧
    effect.state = adopted.state ∧ effect.providerReceipt = adopted.providerReceipt

def E04_ConflictingIdempotencyRejected
    (replay : Effect → Effect → Bool) : Prop :=
  ∀ recorded requested,
    replay recorded requested = true →
    SameLogicalEffect recorded requested ∧ recorded.request = requested.request

def E05_RecoveryBindsExactCheckpoint
    (resume : Artifact → Artifact → Bool) : Prop :=
  ∀ expected observed, resume expected observed = true → expected = observed

/-! B: admission and settlement are different theorems -/

def B01_ReservePreservesCap
    (reserve : Budget → Nat → Option Budget) : Prop :=
  ∀ before amount after,
    reserve before amount = some after →
    after.project = before.project ∧
    after.capMicroUsd = before.capMicroUsd ∧
    after.spentMicroUsd = before.spentMicroUsd ∧
    after.heldMicroUsd = before.heldMicroUsd + amount ∧
    after.spentMicroUsd + after.heldMicroUsd ≤ after.capMicroUsd

def B02_SettlementExactlyOnce
    (applyReceipt : List Settlement → Settlement → Option (List Settlement)) : Prop :=
  ∀ ledger receipt once,
    applyReceipt ledger receipt = some once → applyReceipt once receipt = some once

def B03_FirstSettlementExact
    (applyReceipt : List Settlement → Settlement → Option (List Settlement)) : Prop :=
  ∀ ledger receipt after,
    (∀ old, old ∈ ledger → ¬ SameSettlement old receipt) →
    applyReceipt ledger receipt = some after →
    ProjectTotal receipt.project after = ProjectTotal receipt.project ledger + receipt.amountMicroUsd

def B04_ProjectAccountingIsolation
    (applyReceipt : List Settlement → Settlement → Option (List Settlement)) : Prop :=
  ∀ ledger receipt other after,
    other ≠ receipt.project →
    applyReceipt ledger receipt = some after →
    ProjectTotal other after = ProjectTotal other ledger

def B05_ConflictingReceiptRejected
    (applyReceipt : List Settlement → Settlement → Option (List Settlement)) : Prop :=
  ∀ ledger receipt old,
    old ∈ ledger → SameSettlement old receipt →
    old.amountMicroUsd ≠ receipt.amountMicroUsd →
    applyReceipt ledger receipt = none

/-! C/M: structural context guarantees, not arbitrary semantic fidelity -/

def C01_MandatoryClosure
    (compile : ContextEmission → Option ContextEmission) : Prop :=
  ∀ input emitted, compile input = some emitted →
    input.project = emitted.project ∧ input.model = emitted.model ∧
    input.authorityPolicy = emitted.authorityPolicy ∧
    input.tokenizer = emitted.tokenizer ∧ input.contextWindow = emitted.contextWindow ∧
    input.reservedOutputTokens = emitted.reservedOutputTokens ∧
    input.required = emitted.required ∧ ContextClosed emitted

def C02_ExactWireTokenBudget
    (count : String → String → Bytes → Option Nat)
    (emitted : ContextEmission) : Prop :=
  count emitted.model emitted.tokenizer emitted.wireRequest =
    some emitted.measuredInputTokens ∧
  emitted.measuredInputTokens + emitted.reservedOutputTokens ≤ emitted.contextWindow

def C03_CompressionEvidencePreserved
    (requiredEvidence outputEvidence : List SourceRef) : Prop :=
  Subset requiredEvidence outputEvidence

def M01_NoTombstoneResurrection
    (retrieve : ProjectId → List SourceRef → List SourceRef) : Prop :=
  ∀ project corpus source,
    source ∈ retrieve project corpus → source ∈ corpus ∧
    source.approved = true ∧ source.tombstoned = false

def M02_RetrievalScopeIsolation
    (retrieve : ProjectId → List SourceRef → List SourceRef) : Prop :=
  ∀ project corpus source,
    source ∈ retrieve project corpus → source.project = project

def M03_ExactSourceLineage
    (revise : SourceRef → SourceRef → Bool) : Prop :=
  ∀ original replacement, revise original replacement = true →
    original.project = replacement.project ∧
    original.id = replacement.id ∧
    replacement.revision = original.revision + 1

/-! V: independent evidence does not assert that the tests are sufficient -/

def V01_IndependentExactAcceptance
    (approve : VerificationManifest → Verification → Bool) : Prop :=
  ∀ frozenManifest receipt, approve frozenManifest receipt = true →
    AcceptableReceipt frozenManifest receipt

def V02_FailDominatesAggregation
    (aggregate : Verification → Bool) : Prop :=
  ∀ receipt, receipt.failedShards ≠ [] → aggregate receipt = false

/-! G: a bounded runner terminates, not necessarily solves the goal -/

def G01_FuelStrictlyDecreases
    (next : Nat → Option Nat) : Prop :=
  ∀ fuel remaining, next fuel = some remaining → remaining < fuel

def G02_PrerequisiteClosure
    (dependencies : TaskId → List TaskId)
    (completed runnable : List TaskId) : Prop :=
  ∀ task, task ∈ runnable → Subset (dependencies task) completed

/-! H: protected kernel and project/model-specific harness evolution -/

def H01_AllowedHarnessChange
    (admitCandidate : Harness → Harness → Bool) : Prop :=
  ∀ baseline candidate, admitCandidate baseline candidate = true →
    baseline.project = candidate.project ∧
    baseline.policyModel = candidate.policyModel ∧
    baseline.authorityPolicy = candidate.authorityPolicy ∧
    baseline.evaluator = candidate.evaluator ∧
    Subset candidate.capabilities baseline.capabilities ∧
    candidate.maxSteps ≤ baseline.maxSteps

def H02_SelectionGates
    (accept : SelectionManifest → Evaluation → Bool) : Prop :=
  ∀ frozen candidate,
    accept frozen candidate = true →
    candidate.candidate = frozen.candidate ∧
    candidate.candidate.author = frozen.submissionAuthor ∧
    candidate.suite = frozen.expectedSuite ∧ candidate.split = "heldout" ∧
    candidate.totalMicroUsd ≤ frozen.maxCostMicroUsd ∧ candidate.scoreBasisPoints ≤ 10000 ∧
    candidate.safetyFailures = 0 ∧
    frozen.bestEver ≤ candidate.scoreBasisPoints + frozen.tolerance ∧
    Authorized candidate.verifier ["verification:write"] ∧
    candidate.verifier.principal ∈ frozen.allowedVerifiers ∧
    candidate.verifier.principal ≠ frozen.submissionAuthor

def H03_NoHeldoutFeedback
    (propose : Bytes → Bytes → Harness) : Prop :=
  ∀ visibleHistory hiddenHeldoutA hiddenHeldoutB,
    propose visibleHistory hiddenHeldoutA = propose visibleHistory hiddenHeldoutB

def H04_PromotionCAS
    (promote : Harness → Nat → Harness → Option Harness) : Prop :=
  (∀ current expected candidate,
    current.version ≠ expected → promote current expected candidate = none) ∧
  ∀ current expected candidate promoted,
    promote current expected candidate = some promoted →
    promoted = candidate ∧ promoted.version = current.version + 1

def H05_RunningHarnessPinned
    (resolveRun : RunPin → Harness → Harness) : Prop :=
  ∀ pin registryHead, resolveRun pin registryHead = pin.harness

def H06_RollbackPreservesSafety
    (safe : Bytes → Harness → Prop)
    (rollback : Bytes → Harness → Harness → Option Harness) : Prop :=
  ∀ currentAuthority bad previous restored,
    rollback currentAuthority bad previous = some restored →
    restored = previous ∧ safe currentAuthority restored

/-! X: the essential bridge from abstract proofs to deployed behavior -/

def X01_ImplementationRefinement
    {Concrete Abstract Event : Type}
    (decode : Concrete → Abstract)
    (implementationStep : Concrete → Event → Concrete → Prop)
    (specificationStep : Abstract → Event → Abstract → Prop) : Prop :=
  ∀ before event after,
    implementationStep before event after →
    specificationStep (decode before) event (decode after)

def X02_InvariantPreservation
    {State Event : Type}
    (initial invariant : State → Prop) (step : State → Event → State → Prop) : Prop :=
  (∀ state, initial state → invariant state) ∧
  ∀ before event after,
    invariant before → step before event after → invariant after

-- This is a deliberately explicit liveness assumption bundle, not a theorem
-- that arbitrary networks or LLMs eventually respond or solve a task.
structure ProgressAssumptions (State : Type) where
  schedulerFair : (Nat → State) → Prop
  leaseServiceAvailable : (Nat → State) → Prop
  admittedCallsReturnOrTimeout : (Nat → State) → Prop
  reconciliationOracleEventuallyAnswers : (Nat → State) → Prop
  finiteAdmittedWork : (Nat → State) → Prop

def X03_ConditionalProgress
    {State : Type} (assumptions : ProgressAssumptions State)
    (admitted terminalOrExplicitlyBlocked : State → Prop)
    (run : Nat → State) : Prop :=
  assumptions.schedulerFair run → assumptions.leaseServiceAvailable run →
  assumptions.admittedCallsReturnOrTimeout run →
  assumptions.reconciliationOracleEventuallyAnswers run →
  assumptions.finiteAdmittedWork run → admitted (run 0) →
  ∃ time, terminalOrExplicitlyBlocked (run time)

end Workroom
