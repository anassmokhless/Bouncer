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

//bouncer pass check (early access)
export async function hasBouncerPass(walletAddress: string): Promise<boolean> {
  const collectionId = process.env.BOUNCER_COLLECTION_ID;
  if (!collectionId) return true; // no collection set = early access disabled

  const tokenId = process.env.BOUNCER_TOKEN_ID || null;
  return checkNftOwnership(walletAddress, collectionId, tokenId, 1);
}

//ntf ownership verification
export async function checkNftOwnership(
  walletAddress: string,
  collectionId: string,
  tokenId: string | null,
  minBalance: number = 1,
): Promise<boolean> {
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
      // Any token in collection: sum all balances
      const q = gql`
        query GetWallet($address: String!, $collectionIds: [BigInt!]) {
          GetWallet(account: $address) {
            tokenAccounts(first: 100, collectionIds: $collectionIds) {
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
        collectionIds: [collectionId],
      });

      if (!data.GetWallet) return false;
      const total = data.GetWallet.tokenAccounts.edges.reduce(
        (sum, e) => sum + parseInt(e.node.balance),
        0,
      );
      return total >= minBalance;
    }
  } catch (error) {
    console.error("[ENJIN] NFT check failed:", error);
    return false;
  }
}
