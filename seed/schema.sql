--
-- PostgreSQL database dump
--

\restrict KxUApdmOegR17nDO26ruL9smHa9XMjpkNuYXYUQCKng2JhVs8BgwKaBwixe0wVa

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: auth_methods_provider_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.auth_methods_provider_enum AS ENUM (
    'telegram',
    'dkbank'
);


--
-- Name: challenges_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.challenges_status_enum AS ENUM (
    'open',
    'active',
    'settled',
    'expired',
    'void'
);


--
-- Name: dispute_bond_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispute_bond_status_enum AS ENUM (
    'locked',
    'rewarded',
    'forfeited',
    'not_applicable'
);


--
-- Name: markets_category_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.markets_category_enum AS ENUM (
    'sports',
    'politics',
    'weather',
    'entertainment',
    'economy',
    'other'
);


--
-- Name: markets_mechanism_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.markets_mechanism_enum AS ENUM (
    'parimutuel'
);


--
-- Name: markets_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.markets_status_enum AS ENUM (
    'upcoming',
    'open',
    'closed',
    'resolving',
    'resolved',
    'settled',
    'cancelled'
);


--
-- Name: payment_otps_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_otps_status_enum AS ENUM (
    'pending',
    'verified',
    'expired',
    'cancelled'
);


--
-- Name: payments_method_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payments_method_enum AS ENUM (
    'dkbank',
    'ton',
    'credits'
);


--
-- Name: payments_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payments_status_enum AS ENUM (
    'pending',
    'success',
    'failed',
    'cancelled'
);


--
-- Name: payments_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payments_type_enum AS ENUM (
    'deposit',
    'withdrawal',
    'position_placed',
    'position_payout',
    'refund'
);


--
-- Name: positions_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.positions_status_enum AS ENUM (
    'pending',
    'won',
    'lost',
    'refunded'
);


--
-- Name: transactions_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transactions_type_enum AS ENUM (
    'deposit',
    'withdrawal',
    'bet_placed',
    'bet_payout',
    'refund',
    'dispute_bond',
    'dispute_refund',
    'referral_bonus',
    'free_credit',
    'streak_bonus',
    'referral_prize',
    'duel_wager',
    'duel_payout',
    'dispute_bond_lock',
    'dispute_bond_forfeit',
    'dispute_bond_reward'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "adminId" character varying NOT NULL,
    username character varying,
    "roleType" character varying NOT NULL,
    action character varying NOT NULL,
    "entityType" character varying,
    "entityId" character varying,
    payload jsonb,
    "ipAddress" character varying,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_methods (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    provider public.auth_methods_provider_enum DEFAULT 'telegram'::public.auth_methods_provider_enum NOT NULL,
    "providerId" character varying NOT NULL,
    metadata jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "userId" uuid NOT NULL
);


--
-- Name: challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenges (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "creatorId" uuid NOT NULL,
    "marketId" uuid NOT NULL,
    "outcomeId" uuid NOT NULL,
    status public.challenges_status_enum DEFAULT 'open'::public.challenges_status_enum NOT NULL,
    "participantCount" integer DEFAULT 0 NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "wagerAmount" numeric(18,2) DEFAULT 0 NOT NULL,
    "joinerId" uuid,
    "winnerId" uuid,
    "settledAt" timestamp with time zone,
    "equippedCard" character varying
);


--
-- Name: disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disputes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    reason text NOT NULL,
    upheld boolean,
    "bondStatus" public.dispute_bond_status_enum DEFAULT 'locked'::public.dispute_bond_status_enum NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "userId" uuid NOT NULL,
    "marketId" uuid NOT NULL,
    "bondAmount" numeric(18,2) DEFAULT 0 NOT NULL
);


--
-- Name: dk_gateway_auth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dk_gateway_auth_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    accesstoken text NOT NULL,
    refreshtoken text,
    expiresat timestamp without time zone NOT NULL,
    createdat timestamp without time zone DEFAULT now() NOT NULL,
    updatedat timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: group_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_memberships (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "chatId" character varying NOT NULL,
    "userId" uuid NOT NULL,
    "joinedAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: markets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.markets (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying NOT NULL,
    description text,
    "imageUrl" character varying,
    "imageUrlAlt" character varying,
    status public.markets_status_enum DEFAULT 'upcoming'::public.markets_status_enum NOT NULL,
    "totalPool" numeric(18,2) DEFAULT 0 NOT NULL,
    "houseEdgePct" numeric(5,2) DEFAULT 5 NOT NULL,
    mechanism public.markets_mechanism_enum DEFAULT 'parimutuel'::public.markets_mechanism_enum NOT NULL,
    "liquidityParam" numeric(18,2) DEFAULT 1000 NOT NULL,
    category public.markets_category_enum DEFAULT 'other'::public.markets_category_enum NOT NULL,
    "resolutionCriteria" text,
    "disputeDeadlineAt" timestamp with time zone,
    "opensAt" timestamp with time zone,
    "closesAt" timestamp with time zone,
    "resolvedAt" timestamp with time zone,
    "externalMatchId" integer,
    "externalSource" character varying(64),
    "externalMarketType" character varying(32),
    "evidenceUrl" character varying,
    "evidenceNote" text,
    "evidenceSubmittedAt" timestamp with time zone,
    "resolvedByAdminId" character varying,
    "windowMinutes" integer DEFAULT 60 NOT NULL,
    "disputeBondPool" numeric(18,2) DEFAULT 0 NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "resolvedOutcomeId" uuid,
    "proposedOutcomeId" uuid
);


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    "timestamp" bigint NOT NULL,
    name character varying NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outcomes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    label character varying NOT NULL,
    "imageUrl" character varying,
    "currentOdds" numeric(10,4) DEFAULT 0 NOT NULL,
    "lmsrProbability" numeric(10,6) DEFAULT 0 NOT NULL,
    "isWinner" boolean DEFAULT false NOT NULL,
    "marketId" uuid NOT NULL,
    "totalBetAmount" numeric(18,2) DEFAULT 0 NOT NULL
);


--
-- Name: payment_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_otps (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    status public.payment_otps_status_enum DEFAULT 'pending'::public.payment_otps_status_enum NOT NULL,
    "lastRequestedAt" timestamp with time zone,
    "verifiedAt" timestamp with time zone,
    "requestCount" integer DEFAULT 1 NOT NULL,
    "failedAttempts" integer DEFAULT 0 NOT NULL,
    "bfsTxnId" character varying,
    "paymentId" uuid,
    "userId" uuid NOT NULL,
    "marketId" uuid,
    "disputeId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    type public.payments_type_enum NOT NULL,
    status public.payments_status_enum DEFAULT 'pending'::public.payments_status_enum NOT NULL,
    method public.payments_method_enum NOT NULL,
    amount numeric(18,2) NOT NULL,
    currency character varying(10) DEFAULT 'BTN'::character varying NOT NULL,
    "externalPaymentId" character varying,
    "referenceId" character varying,
    dkinquiryid character varying,
    dktxnstatusid character varying,
    dkrequestid character varying,
    "customerPhone" character varying,
    description character varying,
    metadata json,
    "failureReason" character varying,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "userId" uuid NOT NULL,
    "confirmedAt" timestamp with time zone
);


--
-- Name: positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.positions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    amount numeric(18,2) NOT NULL,
    status public.positions_status_enum DEFAULT 'pending'::public.positions_status_enum NOT NULL,
    "oddsAtPlacement" numeric(10,4),
    payout numeric(18,2),
    "predictedProbability" numeric(10,6),
    "placedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "poolPctAtBet" numeric(10,6),
    "userId" uuid NOT NULL,
    "marketId" uuid NOT NULL,
    "outcomeId" uuid NOT NULL
);


--
-- Name: reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    "marketId" uuid,
    "positionId" uuid,
    "settlementId" uuid,
    type character varying NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    "expectedAmount" numeric(20,9) NOT NULL,
    "actualAmount" numeric(20,9) NOT NULL,
    difference numeric(20,9) NOT NULL,
    "balanceBeforeExpected" numeric(20,9),
    "balanceAfterExpected" numeric(20,9),
    "balanceBeforeActual" numeric(20,9),
    "balanceAfterActual" numeric(20,9),
    "dkTransferId" character varying,
    "dkStatus" character varying,
    "dkTransferAmount" numeric(20,9),
    details jsonb,
    notes text,
    "resolutionAction" text,
    "correctionTransactionId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "resolvedAt" timestamp without time zone
);


--
-- Name: seasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seasons (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "weekNumber" integer NOT NULL,
    year integer NOT NULL,
    "startsAt" timestamp with time zone NOT NULL,
    "endsAt" timestamp with time zone NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    "winnersSnapshot" jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlements (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "marketId" uuid NOT NULL,
    "winningOutcomeId" uuid NOT NULL,
    "totalBets" integer DEFAULT 0 NOT NULL,
    "winningBets" integer DEFAULT 0 NOT NULL,
    "totalPool" numeric(18,2) DEFAULT 0 NOT NULL,
    "houseAmount" numeric(18,2) DEFAULT 0 NOT NULL,
    "payoutPool" numeric(18,2) DEFAULT 0 NOT NULL,
    "totalPaidOut" numeric(18,2) DEFAULT 0 NOT NULL,
    "settledAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_groups (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "chatId" character varying NOT NULL,
    title character varying,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    type public.transactions_type_enum NOT NULL,
    amount numeric(20,9) NOT NULL,
    "balanceBefore" numeric(20,9) NOT NULL,
    "balanceAfter" numeric(20,9) NOT NULL,
    "positionId" uuid,
    "isBonus" boolean DEFAULT false NOT NULL,
    note character varying,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "userId" uuid NOT NULL,
    "paymentId" uuid
);


--
-- Name: user_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "userId" uuid NOT NULL,
    "sessionId" character varying,
    "eventType" character varying NOT NULL,
    platform character varying,
    meta jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "telegramId" character varying,
    "telegramStreak" integer,
    "firstName" character varying,
    "lastName" character varying,
    username character varying,
    "photoUrl" character varying,
    "isAdmin" boolean DEFAULT false NOT NULL,
    "dkCid" character varying,
    "dkAccountNumber" character varying,
    "dkAccountName" character varying,
    "phoneNumber" character varying,
    "telegramChatId" character varying,
    "telegramPhoneHash" character varying,
    "dkPhoneHash" character varying,
    "telegramLinkedAt" timestamp with time zone,
    "reputationScore" numeric(5,4),
    "reputationTier" character varying DEFAULT 'rookie'::character varying NOT NULL,
    "totalPredictions" integer DEFAULT 0 NOT NULL,
    "correctPredictions" integer DEFAULT 0 NOT NULL,
    "categoryScores" jsonb,
    "brierScore" numeric(5,4),
    "brierCount" integer DEFAULT 0 NOT NULL,
    "lastActiveAt" timestamp with time zone,
    "contrarianWins" integer DEFAULT 0 NOT NULL,
    "contrarianAttempts" integer DEFAULT 0 NOT NULL,
    "contrarianBadge" character varying,
    "betStreakCount" integer DEFAULT 0 NOT NULL,
    "betStreakLastAt" date,
    "streakBoostUsed" boolean DEFAULT false NOT NULL,
    "referredByUserId" uuid,
    "referralBonusTriggered" boolean DEFAULT false NOT NULL,
    "freeCreditGranted" boolean DEFAULT false NOT NULL,
    "bonusBalance" numeric(18,2) DEFAULT 0 NOT NULL,
    "referralPrizeClaimed" boolean DEFAULT false NOT NULL,
    "cardInventory" jsonb DEFAULT '{"ghost": 0, "shield": 0, "doubleDown": 0}'::jsonb NOT NULL,
    "adminTotalResolutions" integer DEFAULT 0 NOT NULL,
    "adminWrongResolutions" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "pwaPasswordHash" character varying
);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: challenges PK_1e664e93171e20fe4d6125466af; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenges
    ADD CONSTRAINT "PK_1e664e93171e20fe4d6125466af" PRIMARY KEY (id);


--
-- Name: migrations PK_8c82d7f526340ab734260ea46be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id);


--
-- Name: audit_logs PK_audit_logs; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT "PK_audit_logs" PRIMARY KEY (id);


--
-- Name: auth_methods PK_auth_methods; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_methods
    ADD CONSTRAINT "PK_auth_methods" PRIMARY KEY (id);


--
-- Name: disputes PK_disputes; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT "PK_disputes" PRIMARY KEY (id);


--
-- Name: dk_gateway_auth_tokens PK_dk_gateway_auth_tokens; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dk_gateway_auth_tokens
    ADD CONSTRAINT "PK_dk_gateway_auth_tokens" PRIMARY KEY (id);


--
-- Name: group_memberships PK_group_memberships; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT "PK_group_memberships" PRIMARY KEY (id);


--
-- Name: markets PK_markets; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.markets
    ADD CONSTRAINT "PK_markets" PRIMARY KEY (id);


--
-- Name: outcomes PK_outcomes; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outcomes
    ADD CONSTRAINT "PK_outcomes" PRIMARY KEY (id);


--
-- Name: payment_otps PK_payment_otps; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "PK_payment_otps" PRIMARY KEY (id);


--
-- Name: payments PK_payments; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "PK_payments" PRIMARY KEY (id);


--
-- Name: positions PK_positions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT "PK_positions" PRIMARY KEY (id);


--
-- Name: reconciliations PK_reconciliations; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliations
    ADD CONSTRAINT "PK_reconciliations" PRIMARY KEY (id);


--
-- Name: seasons PK_seasons; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT "PK_seasons" PRIMARY KEY (id);


--
-- Name: settlements PK_settlements; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT "PK_settlements" PRIMARY KEY (id);


--
-- Name: telegram_groups PK_telegram_groups; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_groups
    ADD CONSTRAINT "PK_telegram_groups" PRIMARY KEY (id);


--
-- Name: transactions PK_transactions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT "PK_transactions" PRIMARY KEY (id);


--
-- Name: user_events PK_user_events; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_events
    ADD CONSTRAINT "PK_user_events" PRIMARY KEY (id);


--
-- Name: users PK_users; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_users" PRIMARY KEY (id);


--
-- Name: users UQ_1eb2bfb05045660f5c286356413; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_1eb2bfb05045660f5c286356413" UNIQUE ("telegramChatId");


--
-- Name: telegram_groups UQ_telegram_groups_chatId; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_groups
    ADD CONSTRAINT "UQ_telegram_groups_chatId" UNIQUE ("chatId");


--
-- Name: transactions UQ_transactions_paymentId; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT "UQ_transactions_paymentId" UNIQUE ("paymentId");


--
-- Name: IDX_1980733727a12aad16f53de8ba; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_1980733727a12aad16f53de8ba" ON public.challenges USING btree ("creatorId");


--
-- Name: IDX_1eb2bfb05045660f5c28635641; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_1eb2bfb05045660f5c28635641" ON public.users USING btree ("telegramChatId");


--
-- Name: IDX_26d3ddc08f3ca2799c6b5ac4d3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_26d3ddc08f3ca2799c6b5ac4d3" ON public.transactions USING btree ("positionId");


--
-- Name: IDX_5d785861562edb80c4ee4137d5; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_5d785861562edb80c4ee4137d5" ON public.group_memberships USING btree ("chatId", "userId");


--
-- Name: IDX_721af04ac41f7598ecb59f5e66; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_721af04ac41f7598ecb59f5e66" ON public.transactions USING btree ("paymentId");


--
-- Name: IDX_8c766089a2073274555d9c7483; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8c766089a2073274555d9c7483" ON public.positions USING btree ("userId", "marketId");


--
-- Name: IDX_933827dc83a6e08eb13e4dc8ce; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_933827dc83a6e08eb13e4dc8ce" ON public.positions USING btree ("placedAt");


--
-- Name: IDX_9d53d8c4d4227c02e4476129d2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9d53d8c4d4227c02e4476129d2" ON public.audit_logs USING btree ("adminId");


--
-- Name: IDX_9f256ed73736fd576726a9b42d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9f256ed73736fd576726a9b42d" ON public.challenges USING btree ("marketId", status);


--
-- Name: IDX_aa48db7b32c4f04a68fbe20119; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_aa48db7b32c4f04a68fbe20119" ON public.payment_otps USING btree ("userId");


--
-- Name: IDX_afcac02f3aaf4923b99b11970e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_afcac02f3aaf4923b99b11970e" ON public.payment_otps USING btree ("paymentId");


--
-- Name: IDX_disputes_bondStatus; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_disputes_bondStatus" ON public.disputes USING btree ("bondStatus");


--
-- Name: IDX_disputes_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_disputes_userId" ON public.disputes USING btree ("userId");


--
-- Name: IDX_e32b137e223c851193abf6bc7b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e32b137e223c851193abf6bc7b" ON public.challenges USING btree ("creatorId", status);


--
-- Name: IDX_f0f834f89f781962d41245f56e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f0f834f89f781962d41245f56e" ON public.payment_otps USING btree ("marketId");


--
-- Name: IDX_f580c073d993620f1aa90cf2e8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f580c073d993620f1aa90cf2e8" ON public.payment_otps USING btree ("disputeId");


--
-- Name: IDX_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_payments_status" ON public.payments USING btree (status);


--
-- Name: IDX_payments_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_payments_userId" ON public.payments USING btree ("userId");


--
-- Name: IDX_positions_placedAt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_positions_placedAt" ON public.positions USING btree ("placedAt");


--
-- Name: IDX_reconciliations_createdAt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reconciliations_createdAt" ON public.reconciliations USING btree ("createdAt");


--
-- Name: IDX_reconciliations_marketId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reconciliations_marketId" ON public.reconciliations USING btree ("marketId");


--
-- Name: IDX_reconciliations_positionId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reconciliations_positionId" ON public.reconciliations USING btree ("positionId");


--
-- Name: IDX_reconciliations_settlementId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reconciliations_settlementId" ON public.reconciliations USING btree ("settlementId");


--
-- Name: IDX_reconciliations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reconciliations_status" ON public.reconciliations USING btree (status);


--
-- Name: IDX_reconciliations_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reconciliations_type" ON public.reconciliations USING btree (type);


--
-- Name: IDX_reconciliations_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reconciliations_userId" ON public.reconciliations USING btree ("userId");


--
-- Name: IDX_user_events_eventType_createdAt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_user_events_eventType_createdAt" ON public.user_events USING btree ("eventType", "createdAt");


--
-- Name: IDX_user_events_userId_createdAt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_user_events_userId_createdAt" ON public.user_events USING btree ("userId", "createdAt");


--
-- Name: positions FK_0cf2caecfba00a6746ec1ff87a3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT "FK_0cf2caecfba00a6746ec1ff87a3" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: challenges FK_1980733727a12aad16f53de8baf; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenges
    ADD CONSTRAINT "FK_1980733727a12aad16f53de8baf" FOREIGN KEY ("creatorId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: challenges FK_2e118d233e9fd497f473c627f06; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenges
    ADD CONSTRAINT "FK_2e118d233e9fd497f473c627f06" FOREIGN KEY ("marketId") REFERENCES public.markets(id) ON DELETE CASCADE;


--
-- Name: disputes FK_4074d1c69ba6b998dcbe6be98e3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT "FK_4074d1c69ba6b998dcbe6be98e3" FOREIGN KEY ("marketId") REFERENCES public.markets(id) ON DELETE CASCADE;


--
-- Name: challenges FK_7b937109deaa8f1631d0411881d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenges
    ADD CONSTRAINT "FK_7b937109deaa8f1631d0411881d" FOREIGN KEY ("joinerId") REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: positions FK_88182c148db063015346795a5ed; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT "FK_88182c148db063015346795a5ed" FOREIGN KEY ("outcomeId") REFERENCES public.outcomes(id);


--
-- Name: payment_otps FK_aa48db7b32c4f04a68fbe201196; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_aa48db7b32c4f04a68fbe201196" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: group_memberships FK_ae52b7a8e0e084d7945522ef762; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT "FK_ae52b7a8e0e084d7945522ef762" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_otps FK_afcac02f3aaf4923b99b11970e7; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_afcac02f3aaf4923b99b11970e7" FOREIGN KEY ("paymentId") REFERENCES public.payments(id) ON DELETE SET NULL;


--
-- Name: auth_methods FK_auth_methods_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_methods
    ADD CONSTRAINT "FK_auth_methods_userId" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: positions FK_ba6a0153ab467b9ec02765d48f0; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT "FK_ba6a0153ab467b9ec02765d48f0" FOREIGN KEY ("marketId") REFERENCES public.markets(id);


--
-- Name: payment_otps FK_f0f834f89f781962d41245f56e1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_f0f834f89f781962d41245f56e1" FOREIGN KEY ("marketId") REFERENCES public.markets(id) ON DELETE SET NULL;


--
-- Name: challenges FK_f2a1952cd8e95e35e5da91c4ec9; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenges
    ADD CONSTRAINT "FK_f2a1952cd8e95e35e5da91c4ec9" FOREIGN KEY ("outcomeId") REFERENCES public.outcomes(id) ON DELETE CASCADE;


--
-- Name: disputes FK_f49c7610167b5a0754f72ab5e34; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT "FK_f49c7610167b5a0754f72ab5e34" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_otps FK_f580c073d993620f1aa90cf2e82; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_f580c073d993620f1aa90cf2e82" FOREIGN KEY ("disputeId") REFERENCES public.disputes(id) ON DELETE SET NULL;


--
-- Name: outcomes FK_outcomes_marketId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outcomes
    ADD CONSTRAINT "FK_outcomes_marketId" FOREIGN KEY ("marketId") REFERENCES public.markets(id) ON DELETE CASCADE;


--
-- Name: payment_otps FK_payment_otps_disputeId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_payment_otps_disputeId" FOREIGN KEY ("disputeId") REFERENCES public.disputes(id) ON DELETE SET NULL;


--
-- Name: payment_otps FK_payment_otps_marketId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_payment_otps_marketId" FOREIGN KEY ("marketId") REFERENCES public.markets(id) ON DELETE SET NULL;


--
-- Name: payment_otps FK_payment_otps_paymentId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_payment_otps_paymentId" FOREIGN KEY ("paymentId") REFERENCES public.payments(id) ON DELETE SET NULL;


--
-- Name: payment_otps FK_payment_otps_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_otps
    ADD CONSTRAINT "FK_payment_otps_userId" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payments FK_payments_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "FK_payments_userId" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: positions FK_positions_marketId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT "FK_positions_marketId" FOREIGN KEY ("marketId") REFERENCES public.markets(id);


--
-- Name: positions FK_positions_outcomeId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT "FK_positions_outcomeId" FOREIGN KEY ("outcomeId") REFERENCES public.outcomes(id);


--
-- Name: positions FK_positions_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT "FK_positions_userId" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reconciliations FK_reconciliations_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliations
    ADD CONSTRAINT "FK_reconciliations_userId" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: transactions FK_transactions_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT "FK_transactions_userId" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_events FK_user_events_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_events
    ADD CONSTRAINT "FK_user_events_userId" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users FK_users_referredByUserId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "FK_users_referredByUserId" FOREIGN KEY ("referredByUserId") REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict KxUApdmOegR17nDO26ruL9smHa9XMjpkNuYXYUQCKng2JhVs8BgwKaBwixe0wVa

