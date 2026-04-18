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
  const q = gql`
    query GetToken($collectionId: BigInt!, $tokenId: EncodableTokenIdInput!) {
      GetToken(collectionId: $collectionId, tokenId: $tokenId) {
        tokenId {
          integer
        }
      }
    }
  `;
  try {
    const data = await getClient().request<{
      GetToken: { tokenId: { integer: string } } | null;
    }>(q, { collectionId, tokenId: { integer: tokenId } });
    return data.GetToken !== null;
  } catch (err) {
    if (isEnjinValidationError(err)) return false;
    console.error("[ENJIN] tokenExists failed:", err);
    return null;
  }
}

//bouncer pass check (early access)
export async function hasBouncerPass(walletAddress: string): Promise<boolean> {
  const collectionId = process.env.BOUNCER_COLLECTION_ID;
  if (!collectionId) return true; // no collection set = early access disabled

  const tokenId = process.env.BOUNCER_TOKEN_ID || null;
  const result = await checkNftOwnership(walletAddress, collectionId, tokenId, 1);
  return result === true; // null (API error) treated as false for bouncer pass
}

//ntf ownership verification — returns null on API error (skip, don't kick)
export async function checkNftOwnership(
  walletAddress: string,
  collectionId: string,
  tokenId: string | null,
  minBalance: number = 1,
): Promise<boolean | null> {
  try {
    if (tokenId) {
      // Specific token: use bulkFilter for exact match
      const q = gql`
        query GetWallet($address: String!, $bulkFilter: [TokenFilterInput!]) {
          GetWallet(account: $address) {
            tokenAccounts(first: 1, bulkFilter: $bulkFilter) {
              edges {
                node {
                  balance
                }
              }
            }
          }
        }
      `;

      const data = await getClient().request<GetWalletResponse>(q, {
        address: walletAddress,
        bulkFilter: [{ collectionId, tokenIds: [tokenId] }],
      });

      if (!data.GetWallet) return false;
      const edges = data.GetWallet.tokenAccounts.edges;
      if (edges.length === 0) return false;
      return parseInt(edges[0].node.balance) >= minBalance;
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
