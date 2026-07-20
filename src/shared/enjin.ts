import { GraphQLClient, gql } from "graphql-request";

let _client: GraphQLClient | null = null;

function getClient() {
  if (!_client) {
    _client = new GraphQLClient(process.env.ENJIN_API_URL!, {
      headers: process.env.ENJIN_API_TOKEN
        ? { Authorization: `Bearer ${process.env.ENJIN_API_TOKEN}` }
        : {},
    });
  }
  return _client;
}

//types
interface TokenAccountNode {
  balance: string;
}

interface GetWalletResponse {
  GetWallet: {
    tokenAccounts: {
      edges: Array<{ node: TokenAccountNode }>;
      pageInfo?: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  } | null;
}

interface RequestAccountResponse {
  RequestAccount: {
    qrCode: string;
    verificationId: string;
  };
}

interface GetWalletByVerificationResponse {
  GetWallet: {
    account: {
      address: string;
    };
  } | null;
}

//request account verification
export async function requestAccountVerification(): Promise<{
  qrCode: string;
  verificationId: string;
}> {
  const query = gql`
    query RequestAccount {
      RequestAccount {
        qrCode
        verificationId
      }
    }
  `;

  const data = await getClient().request<RequestAccountResponse>(query);
  return data.RequestAccount;
}

//accountverification (via qr code)
export async function getVerifiedWallet(
  verificationId: string,
): Promise<string | null> {
  const query: string = gql`
    query GetVerifiedWallet($verificationId: String!) {
      GetWallet(verificationId: $verificationId) {
        account {
          address
        }
      }
    }
  `;

  try {
    const data: GetWalletByVerificationResponse =
      await getClient().request<GetWalletByVerificationResponse>(query, {
        verificationId,
      });
    return data.GetWallet?.account?.address || null;
  } catch {
    return null;
  }
}

// Detect Enjin's "not found" response shape. The Enjin Platform returns a 400
// validation error (category: "validation", extensions.validation.<field>: [...])
// when an ID doesn't exist on-chain — NOT a null result. The graphql-request
// client throws a ClientError for any non-2xx, so the catch block below has to
// discriminate "user typo'd the ID" from "actual API outage" by inspecting the
// error shape. Any validation-category error means the input refers to something
// that doesn't exist on-chain; anything else is a real error.
function isEnjinValidationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    response?: { errors?: Array<{ extensions?: { category?: string } }> };
  };
  const errors = e.response?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((ge) => ge?.extensions?.category === "validation");
}

// Verify an Enjin collection exists. Returns:
//   true  — collection found on-chain
//   false — collection does not exist (or ID is rejected by Enjin's validator)
//   null  — real API error (network, auth, 5xx, schema mismatch, etc.)
// Called from /addrule paths (bot + dashboard) before inserting a rule so admins
// can't accidentally save a collection ID that will never verify anyone.
export async function collectionExists(collectionId: string): Promise<boolean | null> {
  const q = gql`
    query GetCollection($collectionId: BigInt!) {
      GetCollection(collectionId: $collectionId) {
        collectionId
      }
    }
  `;
  try {
    const data = await getClient().request<{
      GetCollection: { collectionId: string } | null;
    }>(q, { collectionId });
    return data.GetCollection !== null;
  } catch (err) {
    if (isEnjinValidationError(err)) return false;
    console.error("[ENJIN] collectionExists failed:", err);
    return null;
  }
}

// Verify a specific token exists in a collection. Same return semantics as
// collectionExists. Only called when the admin supplies a token_id; rules
// that accept "any token in the collection" skip this check.
export async function tokenExists(
  collectionId: string,
  tokenId: string,
): Promise<boolean | null> {
  // Enjin's Token.tokenId output field is a BigInt scalar — sub-selection
  // (e.g. `tokenId { integer }`) throws a schema error. The INPUT type
  // EncodableTokenIdInput still accepts `{integer: ...}` — only the output
  // is scalar. Asking for just `tokenId` is enough to confirm existence.
  const q = gql`
    query GetToken($collectionId: BigInt!, $tokenId: EncodableTokenIdInput!) {
      GetToken(collectionId: $collectionId, tokenId: $tokenId) {
        tokenId
      }
    }
  `;
  try {
    const data = await getClient().request<{
      GetToken: { tokenId: string } | null;
    }>(q, { collectionId, tokenId: { integer: tokenId } });
    return data.GetToken !== null;
  } catch (err) {
    if (isEnjinValidationError(err)) return false;
    console.error("[ENJIN] tokenExists failed:", err);
    return null;
  }
}

//bouncer pass check (early access)
// Returns:
//   true  — wallet holds the pass
//   false — wallet definitively doesn't hold the pass (clean API result)
//   null  — couldn't determine (API error). Callers must treat null conservatively:
//           never make a destructive decision (leaving a group, kicking an admin)
//           on a null result — retry on the next cycle instead. Mirrors the
//           semantics of checkNftOwnership used by the member-gating flow.
export async function hasBouncerPass(walletAddress: string): Promise<boolean | null> {
  const collectionId = process.env.BOUNCER_COLLECTION_ID;
  if (!collectionId) return true; // no collection set = early access disabled

  const tokenId = process.env.BOUNCER_TOKEN_ID || null;
  return checkNftOwnership(walletAddress, collectionId, tokenId, 1);
}

//ntf ownership verification — returns null on API error (skip, don't kick)
export async function checkNftOwnership(
  walletAddress: string,
  collectionId: string,
  tokenId: string | null,
  minBalance: number = 1,
): Promise<boolean | null> {
  // Enforcement floor for the gate threshold. A min_balance < 1 makes every
  // `balance >= minBalance` comparison below true for every wallet — the gate
  // silently opens to anyone. The write paths validate their input, but this
  // is the single point every rule consumer passes through, so it also
  // neutralizes bad rows already in the database and any future writer.
  minBalance = Math.max(1, minBalance);

  try {
    if (tokenId) {
      // Specific token: filter by BOTH collectionId and tokenId server-side, so
      // the API returns at most the single tokenAccount for this wallet+token.
      // Verified against the live schema: a token the wallet doesn't hold yields
      // empty edges (ownership-scoped), a held one returns its balance. No
      // pagination — a wallet holds at most one account per token, so `first: 1`
      // is exact no matter how many tokens the wallet holds. (The old version
      // paged the whole collection hunting for the token and gave up with `null`
      // past ~5000 tokens, so a whale/marketplace wallet could never verify.)
      // Note tokenIds is `[BigInt]`, NOT the EncodableTokenIdInput type the input
      // mutations use.
      const q = gql`
        query GetWallet($address: String!, $collectionIds: [BigInt!], $tokenIds: [BigInt]) {
          GetWallet(account: $address) {
            tokenAccounts(first: 1, collectionIds: $collectionIds, tokenIds: $tokenIds) {
              edges {
                node {
                  balance
                  token {
                    tokenId
                  }
                }
              }
            }
          }
        }
      `;

      type TokenSpecificResponse = {
        GetWallet: {
          tokenAccounts: {
            edges: Array<{ node: { balance: string; token: { tokenId: string } } }>;
          };
        } | null;
      };

      const data: TokenSpecificResponse = await getClient().request<TokenSpecificResponse>(q, {
        address: walletAddress,
        collectionIds: [collectionId],
        tokenIds: [tokenId],
      });

      if (!data.GetWallet) return false;

      // The server already scopes to this token; the equality check is a
      // defensive guard before trusting the balance.
      const edge = data.GetWallet.tokenAccounts.edges.find(
        (e) => e.node.token.tokenId === tokenId,
      );
      if (!edge) return false; // wallet doesn't hold this token
      return parseInt(edge.node.balance) >= minBalance;
    } else {
      // Any token in collection: sum all balances with pagination
      const q = gql`
        query GetWallet($address: String!, $collectionIds: [BigInt!], $after: String) {
          GetWallet(account: $address) {
            tokenAccounts(first: 100, collectionIds: $collectionIds, after: $after) {
              edges {
                node {
                  balance
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `;

      // Hard page cap prevents runaway pagination on pathological wallets (e.g. an
      // attacker who minted many tokens in the target collection and transferred them
      // out, leaving thousands of zero-balance tokenAccount records). Without the cap,
      // one bad wallet in a recheck batch can stall the entire cron for minutes via
      // Promise.all. 50 pages × 100 tokens = 5000 token accounts — far above any
      // realistic legitimate holder. If the cap is hit without meeting the threshold,
      // return null (same semantic as any other API error: skip this rule this cycle,
      // don't make a false-negative decision).
      const MAX_PAGES = 50;
      let pageCount = 0;
      let totalBalance = 0;
      let hasNextPage = true;
      let afterCursor: string | null = null;

      while (hasNextPage && pageCount < MAX_PAGES) {
        const data: GetWalletResponse = await getClient().request<GetWalletResponse>(q, {
          address: walletAddress,
          collectionIds: [collectionId],
          after: afterCursor,
        });

        if (!data.GetWallet) return false;

        for (const edge of data.GetWallet.tokenAccounts.edges) {
          totalBalance += parseInt(edge.node.balance);
        }

        // Early exit if threshold already met
        if (totalBalance >= minBalance) return true;

        hasNextPage = data.GetWallet.tokenAccounts.pageInfo?.hasNextPage ?? false;
        afterCursor = data.GetWallet.tokenAccounts.pageInfo?.endCursor ?? null;
        pageCount++;
      }

      if (hasNextPage) {
        // Cap hit with more pages remaining and threshold not met — can't fairly decide.
        console.warn(`[ENJIN] Pagination cap (${MAX_PAGES} pages) hit for ${walletAddress} in collection ${collectionId} (minBalance=${minBalance}, summed=${totalBalance}) — returning null`);
        return null;
      }

      return totalBalance >= minBalance;
    }
  } catch (error) {
    console.error("[ENJIN] NFT check failed:", error);
    return null;
  }
}
