# Chain Signatures + x402 on NEAR: implementation facts

Researched 2026-11-05. Sources are primary only: source code pinned to a commit, live RPC calls, and registry metadata. Anything not confirmed from a source or a live call is marked **UNVERIFIED**.

Pinned sources (all citations below use these commits):

| Repo | Commit |
|---|---|
| near/mpc | [`626d5b3`](https://github.com/near/mpc/tree/626d5b3c8281aca6ef4c16d7f87d57c24c38fcfa) |
| near/nearcore | [`a79a148`](https://github.com/near/nearcore/tree/a79a148ee53acffb81e7b1313f0b53ccbad61f12) |
| near/near-sdk-rs | [`bacd081`](https://github.com/near/near-sdk-rs/tree/bacd081a0bd648d840b814dab7677e1f3330afbb) |
| x402-foundation/x402 (the repo npm `@x402/*` 2.30.0 points to) | [`6a773db`](https://github.com/x402-foundation/x402/tree/6a773dba564d29730bd01e2b0ee6b44dc1c5415b) |
| coinbase/x402 (default branch is older, at 2.28.0) | [`0e6e8c5`](https://github.com/coinbase/x402/tree/0e6e8c55d86b4f14234fb6e49a4052074fb93e57) |
| near/near-sandbox-rs | [`56e17cd`](https://github.com/near/near-sandbox-rs/tree/56e17cd309bcf98645d306bca80dbeca3bab33c9) |
| near/omni-transaction-rs | [`70930eb`](https://github.com/near/omni-transaction-rs/tree/70930eb98eff588ca18f47602f6a3738935c0b2b) |

Short links used below: `MPC` = `https://github.com/near/mpc/blob/626d5b3c8281aca6ef4c16d7f87d57c24c38fcfa`, `NC` = `https://github.com/near/nearcore/blob/a79a148ee53acffb81e7b1313f0b53ccbad61f12`, `SDK` = `https://github.com/near/near-sdk-rs/blob/bacd081a0bd648d840b814dab7677e1f3330afbb`, `X4` = `https://github.com/x402-foundation/x402/blob/6a773dba564d29730bd01e2b0ee6b44dc1c5415b`.

The NEAR mechanism source is identical in coinbase/x402 and x402-foundation/x402, except for an extra `errorMessage` on settle failures in the latter. The core HTTP server and client differ between the two repos, so the citations below use x402-foundation.

---

## 1. Signer contract

| Network | Account | Live check (2026-11-05) |
|---|---|---|
| testnet | **`v1.signer-prod.testnet`** (still current) | exists, `version()` = `"3.18.0"` |
| mainnet | **`v1.signer`** | exists, `version()` = `"3.17.0"` |

- docs.near.org names these same two accounts: https://docs.near.org/chain-abstraction/chain-signatures/implementation.
- `v1.signer-dev.testnet` also exists, but it is a dev deployment. Don't use it.

## 2. `sign`

Defined at `MPC/crates/contract/src/api/sign.rs#L26-L81` as `#[payable] fn sign(&mut self, request: SignRequestArgs)`. The args are wrapped in a **`request`** key.

**Args JSON for EdDSA (what to send):**

```json
{ "request": { "path": "x402/0", "payload_v2": { "Eddsa": "<lowercase hex>" }, "domain_id": 1 } }
```

| Item | Fact | Source |
|---|---|---|
| Field names | `path` (string), `payload_v2` (tagged enum), `domain_id` (integer) | `MPC/crates/near-mpc-crypto-types/src/sign.rs#L30-L39`; README `MPC/crates/contract/README.md#L63-L102` |
| `domain_id` vs `key_version` | `key_version` is a deprecated alias for `domain_id`, and sending both is an error. Legacy untagged `payload` (raw `[u8;32]`) is always treated as ECDSA, so **never use it for Ed25519** | `sign.rs#L48-L94`; README `#L300` |
| Payload encoding | `{"Eddsa": "<hex>"}`, a hex string (not a byte array), from the `hex_serde` attribute | `MPC/crates/near-mpc-crypto-types/src/primitives.rs#L89-L108` |
| Length | The README says 32 to 1232 bytes. The type's upper bound is `EDDSA_PAYLOAD_SIZE_UPPER_BOUND_BYTES = 1232` | README `#L70`, `#L285`; `primitives.rs#L68` |
| Scheme check | On a Frost (Ed25519) domain the payload must be the `Eddsa` variant or the call panics `"Payload is not EdDSA"` | `sign.rs#L52-L54` |
| Signature semantics | Plain Ed25519 over the payload bytes (no prehash). Verified with `env::ed25519_verify(signature, message, derived_pk)` | `sign.rs#L135-L149`; `MPC/crates/near-mpc-signature-verifier/src/lib.rs#L30-L41` |
| Deposit | At least **1 yoctoNEAR**. Any excess is refunded | `MPC/crates/near-mpc-contract-interface/src/deposits.rs#L4`; `MPC/crates/contract/src/api/common.rs#L67-L69`; README `#L55-L57` |
| Gas | The contract requires prepaid gas of at least `config.sign_call_gas_attachment_requirement_tera_gas`. **Live testnet value is 15 Tgas.** The README still says 10 Tgas, so it is stale. The signer's own resume callback uses 7 Tgas | `common.rs#L56-L65`; live `config()` (below) |
| Return (success) | `SignatureResponse`, internally tagged by `scheme`: `{"scheme":"Ed25519","signature":[64 integers]}`. The signature is a JSON **array of 64 numbers**, not hex or base58 | `primitives.rs#L166-L170`, `#L192-L199` |
| Yield/resume timeout | Protocol parameter `yield_timeout_length_in_blocks: 200` (about 200 blocks) | `NC/core/parameters/res/runtime_configs/parameters.yaml#L340` |
| On timeout | The signer's callback pops the pending request and calls `fail_on_timeout`, which panics with `"Request has timed out."`. The caller's callback sees `PromiseError::Failed`. Refunds or deposit behaviour on timeout are **UNVERIFIED** | `sign.rs#L191-L218`; `common.rs#L111-L118`; `MPC/crates/contract/src/errors.rs#L63-L64` |
| Duplicates | An identical (predecessor, path, payload, domain) request while one is pending is queued, up to 128, and answered together | README `#L272`; `MPC/crates/contract/src/pending_requests.rs#L35` |

**What to send as the payload:** NEAR verifies a delegate signature as Ed25519 over the **32-byte sha256 hash** of `borsh(SignableMessage)` (`NC/core/primitives/src/action/delegate.rs#L83-L95`, `#L353-L357`). So the contract sends `payload_v2 = {"Eddsa": hex(sha256(prefix_le_u32 ++ borsh(DelegateAction)))}`, which is 32 bytes. Do not send the raw message. The MPC network would sign it correctly, but the signature would not verify against what NEAR checks.

**Live `config()` on `v1.signer-prod.testnet` (excerpt):** `sign_call_gas_attachment_requirement_tera_gas: 15`, `return_signature_and_clean_state_on_success_call_tera_gas: 7`, `fail_on_timeout_tera_gas: 2`.

**Calling from a contract.** The in-repo test contract shows the pattern: an `#[ext_contract]` trait with `fn sign(&mut self, request: SignRequestArgs)`, then `.with_attached_deposit(1 yocto).with_static_gas(15 Tgas)` (`MPC/crates/test-parallel-contract/src/lib.rs#L8-L11`, `#L21-L22`, `#L173-L178`). The deposit comes from the calling contract's balance, so the Agent's function-call key needs no deposit itself. Total gas to budget = 15 Tgas for the signer plus our own callback gas. The exact headroom isn't measured yet (**UNVERIFIED**).

## 3. Domains

- **View method:** `state()` returns `{"Running": {"domains": {"domains": [...], "next_domain_id": N}, "keyset": {...}, ...}}` (`MPC/crates/contract/src/api/lifecycle.rs#L190`). `public_key({"domain_id": n})` returns the root key (`MPC/crates/contract/src/api/keys.rs#L18-L21`).
- **Live testnet `state().Running.domains`** (2026-11-05). Mainnet `v1.signer` has the same id/protocol layout.

| id | protocol | purpose | key |
|---|---|---|---|
| 0 | CaitSith | Sign | secp256k1 |
| **1** | **Frost** | **Sign** | **Ed25519**, root `ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2` (testnet) |
| 2 | ConfidentialKeyDerivation | CKD | bls12381 |
| 3 | CaitSith | ForeignTx | secp256k1 |

**The Ed25519 domain is `domain_id = 1`** on both testnet and mainnet. docs.near.org also lists `0` = Secp256k1 and `1` = Ed25519: https://docs.near.org/chain-abstraction/chain-signatures.

## 4. `derived_public_key`

Defined at `MPC/crates/contract/src/api/keys.rs#L28-L59`:

| Arg | Type | Default if omitted |
|---|---|---|
| `path` | string | required |
| `predecessor` | AccountId or null | `env::predecessor_account_id()` |
| `domain_id` | integer or null | **legacy ECDSA domain (0)**. Always pass `1` |

- **Return:** a JSON string `"ed25519:<base58 32 bytes>"` (`MPC/crates/near-mpc-crypto-types/src/crypto.rs#L277-L280`). This is the same text format `near_sdk::PublicKey` parses.
- **Derivation (for reference):** `tweak = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)`, then `pk = root + tweak·G` (`MPC/crates/near-mpc-crypto-types/src/kdf.rs#L8-L38`; `MPC/crates/contract/src/crypto_shared/kdf.rs#L27-L33`).
- **Cross-contract:** it is an ordinary public `&self` method, not view-only, so a contract can call it by promise. With `predecessor` omitted it derives for the calling contract. Our contract can call it K times, or pass its own id explicitly, and read the strings in a callback. The gas cost per call (Edwards point math in wasm) has not been measured (**UNVERIFIED**).

**Live calls on testnet** (`view.sh` against `rpc.testnet.near.org` and `test.rpc.fastnear.com`, identical results):

| args | result |
|---|---|
| `{"path":"x402/0","predecessor":"example.testnet","domain_id":1}` | `"ed25519:GkuK8fqvPXpPRhUbRT5Z2t7xNLpV5kCNcSyV4bC8QxQD"` |
| `{"path":"x402/1","predecessor":"example.testnet","domain_id":1}` | `"ed25519:9vrouXvJNpqNjojJgjzTdgyonXhNudpnqKaNvgA2zjZP"` |

## 5. Rust types

| Crate | crates.io version | Notes |
|---|---|---|
| `near-mpc-contract-interface` | 0.0.1 (published 2026-03-12) | Exports `types::{SignRequestArgs, Payload, SignatureResponse, Ed25519Signature, DomainId}` |
| `near-mpc-sdk` | 0.0.1 (2026-03-12) | `sign::SignRequestBuilder` plus re-exports of the types above |
| `near-mpc-crypto-types` | 0.0.1 (2026-03-12) | Underlying types |

- **Caveat:** the published 0.0.1 is a March snapshot and differs from repo HEAD. For example, its `SignRequestArgs` has a field literally named `payload_v2` and an Eddsa lower bound of 32. The wire JSON is the same. Whether it builds for `wasm32` next to near-sdk 5.30 is **UNVERIFIED**. The repo's own test contract uses it as a path dependency (`MPC/crates/test-parallel-contract/Cargo.toml#L17-L18`).
- **Recommendation:** define our own minimal serde structs. Shapes:
  - Request: `{ path: String, payload_v2: { Eddsa: String /*hex*/ }, domain_id: u64 }`, sent as `{"request": <that>}`.
  - Response: `{ scheme: "Ed25519", signature: [u8; 64] /*JSON array*/ }` (serde `tag = "scheme"`). A `Secp256k1` variant exists but we never request it.
  - `derived_public_key` returns a `String` (parse into `near_sdk::PublicKey`).

## 6. Versions and borsh layouts

| Crate | Latest | Use |
|---|---|---|
| `near-sdk` | **5.30.1** (crates.io, 2026-11-05) | No DelegateAction types (no match for `DelegateAction` in `near-sdk/src`). Has `Promise::create_account`, `add_full_access_key(PublicKey)`, `transfer` (`SDK/near-sdk/src/promise.rs#L521`, `#L727`, `#L739-L747`) and `env::sha256_array` (`SDK/near-sdk-env/src/hash.rs#L83`) |
| `near-primitives` / `near-crypto` | 0.38.0 | Real types, but heavy node crates. Not meant for contract wasm (**UNVERIFIED** whether they build) |
| `omni-transaction` | 0.5.0 (near org) | Has borsh `DelegateAction`/`SignedDelegateAction` with feature `near` (`src/near/types/actions.rs#L209-L225`). It has **no** NEP-461 helper and depends on `near-account-id` v2, while near-sdk uses v3 |

**Recommendation: hand-roll the borsh structs.** It's about 60 lines and has no dependency risk.

**Pitfall:** `near_sdk::PublicKey` borsh-serializes as `Vec<u8>`, i.e. a **u32 length prefix** plus curve byte plus key (`SDK/near-sdk-core/src/types/public_key.rs#L145-L147`, `#L216-L221`). That is **not** nearcore's encoding, so don't put it into DelegateAction bytes directly.

**Exact borsh layout (nearcore).** Integers are little-endian. `String`/`AccountId` = u32 len + UTF-8. `Vec<T>` = u32 len + items.

| Type | Layout | Source |
|---|---|---|
| `DelegateAction` | `sender_id: AccountId`, `receiver_id: AccountId`, `actions: Vec<NonDelegateAction>`, `nonce: u64`, `max_block_height: u64`, `public_key: PublicKey` | `NC/core/primitives/src/action/delegate.rs#L46-L64` |
| `SignedDelegateAction` | `delegate_action: DelegateAction`, `signature: Signature` | `delegate.rs#L78-L81` |
| `NonDelegateAction` | newtype over `Action`: u8 variant index + body. FunctionCall = **2**. (Delegate = 8 and DelegateV2 = 14 are rejected inside) | `delegate.rs#L18-L26`, `#L370-L371`; `NC/core/primitives/src/action/mod.rs#L373-L396` |
| `FunctionCallAction` | `method_name: String`, `args: Vec<u8>`, `gas: u64`, `deposit: u128` | `mod.rs#L261-L268`; `Gas(NearGas)` at `NC/core/primitives-core/src/gas.rs#L28`; `Balance = NearToken` (u128) at `NC/core/primitives-core/src/types.rs#L25` |
| `PublicKey` (ed25519) | `0u8` + 32 raw bytes (no length prefix) | `NC/core/crypto/src/signature.rs#L39-L43`, `#L398-L404` |
| `Signature` (ed25519) | `0u8` + 64 raw bytes | `signature.rs#L1131-L1137` |
| `SignableMessage` | `discriminant: u32` then `borsh(DelegateAction)` | `NC/core/primitives/src/signable_message.rs#L51-L65` |
| NEP-461 prefix for NEP-366 | `(1 << 30) + 366 = 1073742190 = 0x4000016E`, LE bytes **`6e 01 00 40`** | `signable_message.rs#L18-L24`, `#L221-L222` |
| Hash that gets signed | `sha256(borsh(SignableMessage))` | `delegate.rs#L353-L357` |

A `DelegateActionV2` (gas-key nonces, Action 14) also exists (`delegate.rs#L104-L133`). The x402 decoder uses the V1 schema from `@near-js/transactions` (`X4/typescript/packages/mechanisms/near/src/utils.ts#L121`), so **build V1**.

**Nonce rules** (needed because the contract cannot read access-key nonces):

- A key added at height `h` starts at nonce `h*1e6 - 1`, or `(h-1)*1e6` before the `RaiseInitialAccessKeyNonce` feature (`NC/runtime/runtime/src/access_keys.rs#L49-L62`).
- At execution, the delegate nonce must be greater than the key nonce and less than `block_height*1e6` (`NC/runtime/runtime/src/actions.rs#L627-L645`).
- The x402 facilitator checks the same rules at verify time (`X4/.../facilitator/scheme.ts#L228`, `#L250`).
- Suggested (inference, **UNVERIFIED** in tests): `nonce = max(env::block_height()*1e6, last_nonce[key]+1)`. This works when signing happens in a block after the key was added and verification happens in a later block.

## 7. x402 NEAR packages

npm registry, 2026-11-05. All packages point to `github.com/x402-foundation/x402`.

| Package | Latest | Role |
|---|---|---|
| `@x402/core` | **2.30.0** | `x402Client` (`@x402/core/client`), `x402ResourceServer` and `x402HTTPResourceServer` (`@x402/core/server`), `x402Facilitator` (`@x402/core/facilitator`) |
| `@x402/near` | **2.30.0** | `ExactNearScheme` from `@x402/near/exact/client`, `/exact/server` and `/exact/facilitator`; `createFacilitatorNearSigner`, `createClientNearSigner`. Depends on `@near-js/*` ^2.5.1 and `borsh` 1.0.0 |
| `@x402/express`, `@x402/hono`, `@x402/next`, `@x402/fastify` | 2.30.0 | Server middleware |
| `@x402/fetch`, `@x402/axios` | 2.30.0 | Client wrappers (`wrapFetchWithPayment(fetch, client)`) |

**In-process facilitator:**

1. Build the signer with `createFacilitatorNearSigner({ relayers: [{ accountId, secretKey: "ed25519:..." }], rpcUrls?: { "near:testnet": url } })`. The relayer needs a **full-access key** (`X4/typescript/packages/mechanisms/near/src/signers/facilitatorNearSigner.ts#L26-L40`, `#L169`). The default testnet RPC is `https://rpc.testnet.fastnear.com` (`constants.ts#L21`).
2. Create `new x402Facilitator().register("near:testnet", new ExactNearScheme(signer /*, settlementCache?, { maxSponsoredGas? } */))` (`X4/.../near/src/exact/facilitator/scheme.ts#L63-L70`; `X4/typescript/packages/core/src/facilitator/x402Facilitator.ts#L89`).
3. `x402ResourceServer`'s constructor takes `FacilitatorClient | FacilitatorClient[]` (`X4/typescript/packages/core/src/server/x402ResourceServer.ts#L423`). `x402Facilitator.getSupported()` is **sync** while `FacilitatorClient.getSupported()` is async, so wrap it in a 3-method adapter: `verify`, `settle`, and `getSupported: () => Promise.resolve(f.getSupported())`. The upstream test does exactly this (`X4/typescript/packages/mechanisms/near/test/integrations/exact-near.test.ts#L31-L54`, `#L101-L107`).
4. Register the server scheme with `server.register("near:testnet", new ExactNearScheme())` from `/exact/server`, then `await server.initialize()`. If the route sets no `maxTimeoutSeconds`, it defaults to 300 (`x402ResourceServer.ts#L886`).

**Client attaching a pre-built SignedDelegateAction:**

- Implement `ClientNearSigner` as `{ createSignedDelegateAction: async ({ paymentRequirements }) => "<base64 borsh SignedDelegateAction>" }` (`X4/.../near/src/signer.ts#L20-L28`). Register it with `new x402Client().register("near:testnet", new ExactNearScheme(thatSigner))` (`client/scheme.ts#L19`, `#L40-L51`).
- Payload shape: `{"signedDelegateAction": "<base64 standard>"}` (`X4/.../near/src/types.ts#L7-L9`). Spec: `X4/specs/schemes/exact/scheme_exact_near.md#L85-L95`.
- **Header:** `PAYMENT-SIGNATURE` = base64(JSON `PaymentPayload` `{x402Version: 2, accepted: <requirements>, payload: {signedDelegateAction}, resource?, extensions?}`) (`X4/typescript/packages/core/src/http/index.ts#L17-L19`; `x402HTTPClient.ts#L97`; server reads it at `x402HTTPResourceServer.ts#L1308-L1309`; `PaymentPayload` at `types/payments.ts#L30-L36`). The 402 response uses the `PAYMENT-REQUIRED` header.

**Verifier rules our contract must satisfy** (`X4/.../near/src/exact/facilitator/scheme.ts`):

- Exactly 1 action (`#L170`): `FunctionCall` `ft_transfer` on `receiver_id == asset`, with args `{receiver_id == payTo, amount == amount}` (string-exact).
- Deposit exactly 1 yocto (`#L200`). Gas ≤ 100 Tgas by default (`constants.ts#L48`). The x402 reference client uses 30 Tgas.
- `0 < max_block_height − current_final_height ≤ maxTimeoutSeconds`, at 1 block per second (`#L217-L227`; `utils.ts#L196-L199`). The contract needs the seller's `maxTimeoutSeconds` (or a smaller window) when it builds the delegate.
- Nonce `< height*1e6` and greater than the on-chain key nonce (`#L228`, `#L250`).
- The key must be **FullAccess** (`#L255-L260`).
- The payer must hold the balance, and `payTo` must be storage-registered on the token (`#L290-L320`).
- The payer must not be one of the facilitator's relayers (`#L165`).

## 8. Sandbox

| Tool | Latest | Status | macOS arm64 |
|---|---|---|---|
| `near-workspaces` (Rust) | **0.24.0** (2026-10-26) | Maintained (repo pushed 2026-10-26). Depends on `near-sandbox` 0.4.0 | Yes, via near-sandbox |
| `near-sandbox` (Rust) | **0.4.0** (2026-10-26) | Maintained. Default sandbox binary is nearcore **2.14.0** (`near-sandbox-rs/src/lib.rs#L28`) | **Yes**: platforms are `Darwin-arm64`, Linux x86_64 and Linux aarch64. Darwin x86_64 is not supported (`src/runner/mod.rs#L91-L100`). The binary URL for `Darwin-arm64/2.14.0` returns HTTP 200 |
| `near-sandbox` (npm) | 0.3.5 (2026-11-04) | Maintained (repo pushed 2026-11-04) | **UNVERIFIED** |
| `near-workspaces` (npm) | 5.0.0 (2025-03-13) | Last release over a year old (repo pushed 2025-11) | **UNVERIFIED** |
| `near-api-js` | 7.4.0 (2026-10-23) | Maintained | n/a |
| `@near-js/*` | 2.5.1 (2025-11-06) | Used by `@x402/near` | n/a |

**Recommendation:** Rust `near-workspaces` 0.24 for contract integration tests.

The sandbox has **no MPC signer**. Tests need a mock signer contract that implements `sign`, with yield/resume or a direct return of `{"scheme":"Ed25519","signature":[...]}` signed by a test key, and `derived_public_key`. The mpc repo's `sandbox-test-methods` feature only adds introspection views, not a mock (`MPC/crates/contract/src/sandbox_test_methods.rs#L1-L9`). Whether a real MPC contract can run in sandbox is **UNVERIFIED**.

## 9. Circle USDC on NEAR testnet

- **Contract:** `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (implicit account). It is the x402 default testnet asset (`X4/typescript/packages/mechanisms/near/src/defaultAssets.ts#L20-L26`).
  - Live `ft_metadata`: `name: "USDC"`, `symbol: "USDC"`, `decimals: 6`.
  - Live `storage_balance_bounds`: min = max = `1250000000000000000000` yocto (0.00125 NEAR). The Payer Account and every Payee need `storage_deposit`.
  - Mainnet: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (`defaultAssets.ts#L13-L18`).
- **Faucet:** https://faucet.circle.com lists **"Near Testnet"**. No account or login is needed, but it is **reCAPTCHA-protected**, so it needs a browser and a human. It gives 20 USDC per request, one request per asset/network pair every 2 hours per address. Read from the live page 2026-11-05. Whether it pays to a named `.testnet` account or only to an implicit account is **UNVERIFIED**.

## Verified on testnet (2026-11-05, ticket #2)

- Payer Account `pay.allowance.allowance-owner-yinu9f.testnet` was created by the contract with exactly 4 FullAccess keys from `derived_public_key` (paths `x402/0..3`, domain 1); `v1.signer-prod.testnet` independently returns the same `x402/0` key.
- A contract-built, MPC-signed Signed Payment (0.01 USDC) was verified and settled by the unmodified `@x402/near` 2.30.0 facilitator: settlement tx [3t3hvhwW…](https://testnet.nearblocks.io/txns/3t3hvhwWpTwotjo31UD4maeKDYzqnBKAS8zgux29ygQC), final `SuccessValue`, NEP-141 `ft_transfer` payer → payee.
- Signing latency: ~5–7 s from `tracer_sign` to `Signed`. End to end (sign, verify, settle): ~17 s.
- Nonce rule `max((block_height − 1) × 1e6, last + 1)` and `max_block_height = block_height + 60` passed the facilitator's final-height checks.
- **RPC speed matters.** With `rpc.testnet.near.org` (~3 s/call) the facilitator's checks outlasted a 60-block window and settlement failed with `DelegateActionExpired` ([XHBjcVSx…](https://testnet.nearblocks.io/txns/XHBjcVSxemzND53dn1nubaVp7dK8rYscPzxo2HZuo6g)). FastNEAR (~0.7 s/call) settles comfortably. That expired payment's 0.01 USDC stays in the Payer Account, counted as spent, as ADR 0003 intends.
- `x402Client` applies a default $1 per-payment spend control on default assets; the tracer disables it because the contract enforces the Policy.
