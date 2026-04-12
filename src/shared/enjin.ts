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
  token: {
    tokenId: string;
    collection: {
      collectionId: string;
    };
  };
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
  const query = gql`
    query GetWallet($address: String!) {
      GetWallet(account: $address) {
        tokenAccounts(first: 100) {
          edges {
            node {
              balance
              token {
                tokenId
                collection {
                  collectionId
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await getClient().request<GetWalletResponse>(query, {
      address: walletAddress,
    });

    if (!data.GetWallet) return false;

    const tokens = data.GetWallet.tokenAccounts.edges.map((e) => e.node);

    return tokens.some((t) => {
      const matchesCollection = t.token.collection.collectionId === collectionId;
      const matchesToken = tokenId ? t.token.tokenId === tokenId : true;
      const matchesBalance = parseInt(t.balance) >= minBalance;
      return matchesCollection && matchesToken && matchesBalance;
    });
  } catch (error) {
    console.error("[ENJIN] NFT check failed:", error);
    return false;
  }
}
