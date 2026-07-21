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

// Enjin returns a "validation"-category 400 for an ID that doesn't exist
// on-chain. This distinguishes that (a typo'd ID) from a real API outage.
function isEnjinValidationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    response?: { errors?: Array<{ extensions?: { category?: string } }> };
  };
  const errors = e.response?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((ge) => ge?.extensions?.category === "validation");
}

// Does the collection exist on-chain? true / false / null (API error).
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

// Does the token exist in the collection? Same tri-state as collectionExists.
export async function tokenExists(
  collectionId: string,
  tokenId: string,
): Promise<boolean | null> {
  // Token.tokenId is a scalar output — select it directly (no sub-selection).
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

// Does the wallet hold the Bouncer Pass? true / false / null (API error — never
// act destructively on null).
export async function hasBouncerPass(walletAddress: string): Promise<boolean | null> {
  const collectionId = process.env.BOUNCER_COLLECTION_ID;
  if (!collectionId) return true; // no collection set = early access disabled

  const tokenId = process.env.BOUNCER_TOKEN_ID || null;
  return checkNftOwnership(walletAddress, collectionId, tokenId, 1);
}

// NFT ownership check — true / false / null (API error: skip, don't kick).
export async function checkNftOwnership(
  walletAddress: string,
  collectionId: string,
  tokenId: string | null,
  minBalance: number = 1,
): Promise<boolean | null> {
  // Floor the threshold: a min_balance < 1 would pass every wallet. This is the
  // single point every consumer hits, so it also neutralizes bad stored rows.
  minBalance = Math.max(1, minBalance);

  try {
    if (tokenId) {
      // Filter by collectionId AND tokenId server-side: the wallet holds at most
      // one account per token, so first:1 is exact and no pagination is needed.
      // Empty edges = not held. (tokenIds is [BigInt], not EncodableTokenIdInput.)
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

      // Defensive: the server already scopes to this token.
      const edge = data.GetWallet.tokenAccounts.edges.find(
        (e) => e.node.token.tokenId === tokenId,
      );
      if (!edge) return false; // wallet doesn't hold this token
      return parseInt(edge.node.balance) >= minBalance;
    } else {
      // Any token in the collection: sum balances across pages.
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

      // Cap pagination against pathological wallets (thousands of zero-balance
      // token accounts). 5000 accounts is far above any real holder; hitting the
      // cap returns null (inconclusive), like any other API error.
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

        if (totalBalance >= minBalance) return true; // early exit

        hasNextPage = data.GetWallet.tokenAccounts.pageInfo?.hasNextPage ?? false;
        afterCursor = data.GetWallet.tokenAccounts.pageInfo?.endCursor ?? null;
        pageCount++;
      }

      if (hasNextPage) {
        // Cap hit without meeting the threshold — inconclusive.
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
