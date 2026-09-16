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

// Every collection/token/account query is scoped to a chain now, so these ride
// along on all of them. ENJIN/MATRIX is the mainnet matrixchain where tokens
// live; CANARY/MATRIX is the testnet equivalent.
const NETWORK = process.env.ENJIN_NETWORK || "ENJIN";
const CHAIN = process.env.ENJIN_CHAIN || "MATRIX";

interface LinkingCode {
  idempotencyKey: string;
  code: string;
  qr: string;
  url: string;
  expires: string;
}

// Starts a wallet link. The idempotency key is the handle we poll with later,
// so it is what goes in pending_verifications. `qr` is an image URL that
// Telegram can send directly; `code` and `url` are the same link in the forms
// a user can type or tap, which matters when they cannot scan their own screen.
export async function requestAccountVerification(): Promise<LinkingCode> {
  const q = gql`
    mutation CreateLinkingCode {
      CreateLinkingCode {
        idempotencyKey
        code
        qr
        url
        expires
      }
    }
  `;

  const data = await getClient().request<{ CreateLinkingCode: LinkingCode }>(q);
  return data.CreateLinkingCode;
}

// Has the user approved the link yet? Returns the SS58 address, or null while
// it is still pending.
//
// GetLinkedWallet hands back a hex public key, but every other query and the
// whole dashboard speak SS58, so resolve it through GetAccount rather than
// storing two address formats. GetAccount accepts the hex and echoes the SS58
// back, which saves pulling in an SS58 codec.
export async function getVerifiedWallet(
  idempotencyKey: string,
): Promise<string | null> {
  const linked = gql`
    query GetLinkedWallet($idempotencyKey: String) {
      GetLinkedWallet(idempotencyKey: $idempotencyKey) {
        publicKey
      }
    }
  `;

  const resolve = gql`
    query GetAccount($network: Network!, $chain: Chain!, $address: String!) {
      GetAccount(network: $network, chain: $chain, address: $address) {
        address
      }
    }
  `;

  try {
    const data = await getClient().request<{
      GetLinkedWallet: { publicKey: string } | null;
    }>(linked, { idempotencyKey });

    const publicKey = data.GetLinkedWallet?.publicKey;
    if (!publicKey) return null;

    const account = await getClient().request<{
      GetAccount: { address: string } | null;
    }>(resolve, { network: NETWORK, chain: CHAIN, address: publicKey });

    return account.GetAccount?.address || null;
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
    query GetCollection($network: Network!, $chain: Chain!, $id: BigInt!) {
      GetCollection(network: $network, chain: $chain, id: $id) {
        id
      }
    }
  `;
  try {
    const data = await getClient().request<{
      GetCollection: { id: string } | null;
    }>(q, { network: NETWORK, chain: CHAIN, id: collectionId });
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
  // tokenId is a plain BigInt now, not the old EncodableTokenIdInput wrapper.
  const q = gql`
    query GetToken($network: Network!, $chain: Chain!, $collectionId: BigInt, $tokenId: BigInt) {
      GetToken(network: $network, chain: $chain, collectionId: $collectionId, tokenId: $tokenId) {
        tokenId
      }
    }
  `;
  try {
    const data = await getClient().request<{
      GetToken: { tokenId: string } | null;
    }>(q, { network: NETWORK, chain: CHAIN, collectionId, tokenId });
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

interface AccountToken {
  balance: string;
  token: { tokenId: string };
}

interface GetAccountResponse {
  GetAccount: { tokens: AccountToken[] } | null;
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

  const q = gql`
    query GetAccount(
      $network: Network!
      $chain: Chain!
      $address: String!
      $limit: Int!
      $after: Int
      $collectionId: BigInt
      $tokenIds: [BigInt!]
    ) {
      GetAccount(network: $network, chain: $chain, address: $address) {
        tokens(
          limit: $limit
          after: $after
          collectionId: $collectionId
          tokenIds: $tokenIds
        ) {
          balance
          token {
            tokenId
          }
        }
      }
    }
  `;

  try {
    if (tokenId) {
      // Filter by collectionId AND tokenId server-side: the wallet holds at most
      // one account per token, so a limit of 1 is exact and no paging is needed.
      // An empty array means not held.
      const data = await getClient().request<GetAccountResponse>(q, {
        network: NETWORK,
        chain: CHAIN,
        address: walletAddress,
        limit: 1,
        after: 0,
        // collectionId is singular here on purpose: the server rejects
        // collectionIds alongside tokenIds, and tokenIds alone.
        collectionId,
        tokenIds: [tokenId],
      });

      if (!data.GetAccount) return false;

      // Defensive: the server already scopes to this token. Compare as BigInt —
      // Enjin serializes tokenId normalized ("7"), so a stored "007" would never
      // match as a string and every holder would read as a clean not-held.
      const held = data.GetAccount.tokens.find(
        (t) => BigInt(t.token.tokenId) === BigInt(tokenId),
      );
      if (!held) return false; // wallet doesn't hold this token
      return parseInt(held.balance) >= minBalance;
    }

    // Any token in the collection: sum balances across pages. `after` is a plain
    // offset, and there is no pageInfo — a short page is the end of the list.
    const PAGE = 100;

    // Cap pagination against pathological wallets (thousands of zero-balance
    // token accounts). 5000 accounts is far above any real holder; hitting the
    // cap returns null (inconclusive), like any other API error.
    const MAX_PAGES = 50;
    let pageCount = 0;
    let totalBalance = 0;
    let after = 0;

    while (pageCount < MAX_PAGES) {
      const data: GetAccountResponse = await getClient().request<GetAccountResponse>(q, {
        network: NETWORK,
        chain: CHAIN,
        address: walletAddress,
        limit: PAGE,
        after,
        collectionId,
        tokenIds: null,
      });

      if (!data.GetAccount) return false;

      const tokens = data.GetAccount.tokens;
      for (const t of tokens) {
        totalBalance += parseInt(t.balance);
      }

      if (totalBalance >= minBalance) return true; // early exit

      if (tokens.length < PAGE) return totalBalance >= minBalance; // last page
      after += PAGE;
      pageCount++;
    }

    // Cap hit without meeting the threshold — inconclusive.
    console.warn(`[ENJIN] Pagination cap (${MAX_PAGES} pages) hit for ${walletAddress} in collection ${collectionId} (minBalance=${minBalance}, summed=${totalBalance}) — returning null`);
    return null;
  } catch (error) {
    console.error("[ENJIN] NFT check failed:", error);
    return null;
  }
}
