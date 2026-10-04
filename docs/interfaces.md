# Protocol and interface dependencies

RepoGraph must see useful dependencies that cross source files, packages and repositories through APIs and messaging protocols.

The graph should model the **interaction surface**, not mirror every detail of the protocol specification.

## Core model

An API/message interaction surface is a normal RepoGraph boundary:

```text
Boundary(kind=interface, key=...)
```

Examples:

```text
rest:orders:get:/orders/{id}
soap:OrderService:GetOrder
message:orders.created
```

The stable core still uses only:

```text
DEPENDS_ON
CONTAINS
```

REST, SOAP and messaging are provider/evidence concerns, not new core edge types.

## Why interfaces are explicit nodes

A coarse service-to-service edge creates false positives.

Avoid:

```text
consumer-service DEPENDS_ON provider-service
```

when a more precise interaction surface is known.

Prefer:

```text
consumer implementation
        │ DEPENDS_ON
        ▼
interface boundary
        ▲
        │ DEPENDS_ON
contract artifact
```

A provider implementation may also depend on the same interface when the contract is normative.

This means:

- a contract/interface change can reach consumers and providers;
- an unrelated provider implementation edit does not automatically invalidate every consumer.

## REST / OpenAPI

OpenAPI is the preferred machine-readable source when present.

A provider should normalize only the useful contract surface:

- API/service boundary when needed;
- operation identity from stable `operationId` or HTTP method + normalized path;
- contract artifact provenance;
- client/server artifacts or boundaries with explicit evidence tying them to the operation.

Example:

```text
Artifact(openapi.yaml) [role=contract]
        ▲
        │ DEPENDS_ON
Boundary(interface, rest:orders:get:/orders/{id})
        ▲                         ▲
        │ DEPENDS_ON              │ DEPENDS_ON
Artifact(client.ts)        Artifact(controller.py)
```

Do not persist the full OpenAPI schema/component tree by default.

Request/response schemas become additional graph artifacts only when a real query needs that precision.

If no OpenAPI contract exists, a framework-specific provider may derive route operations only from deterministic framework metadata. RepoGraph core does not parse every REST framework.

## SOAP / WSDL

Use mature WSDL tooling.

Useful normalized concepts are:

- the WSDL artifact;
- service/interface operation as an interface boundary;
- generated/configured client dependencies;
- server implementation dependencies when explicitly tied to the operation.

WSDL bindings, ports and endpoint addresses are provider evidence/configuration unless a consumer query proves they deserve graph identity.

Do not persist the full WSDL/XML schema object graph.

Example:

```text
Artifact(OrderService.wsdl) [role=contract]
        ▲
        │ DEPENDS_ON
Boundary(interface, soap:OrderService:GetOrder)
        ▲
        │ DEPENDS_ON
Artifact(OrderClient.java)
```

## Messaging / AsyncAPI / JMS

Message-driven dependencies should be modeled around a stable channel/operation interface.

AsyncAPI is preferred when available because it explicitly describes channels and send/receive operations and can carry protocol-specific bindings.

Example:

```text
Artifact(asyncapi.yaml) [role=contract]
        ▲
        │ DEPENDS_ON
Boundary(interface, message:orders.created)
       ▲                         ▲
       │ DEPENDS_ON              │ DEPENDS_ON
producer implementation   consumer implementation
```

The causal shared dependency is the message/channel contract, not a blanket producer-to-consumer relation.

### JMS without AsyncAPI

A JMS provider may use deterministic evidence from:

- queue/topic configuration;
- JNDI/admin definitions;
- framework metadata;
- generated descriptors;
- explicit annotations/configuration.

Do not treat arbitrary string literals as destinations.

JMS destination names must be provider/environment scoped when necessary; the messaging API itself does not define one universal address syntax.

## Direction

The same generic rule applies everywhere:

```text
A DEPENDS_ON B
```

means changing B is a justified reason to re-evaluate A.

Examples:

```text
REST client DEPENDS_ON REST operation
REST server implementation DEPENDS_ON REST operation
REST operation DEPENDS_ON OpenAPI artifact

SOAP client DEPENDS_ON WSDL operation
WSDL operation DEPENDS_ON WSDL artifact

message producer DEPENDS_ON message/channel contract
message consumer DEPENDS_ON message/channel contract
message/channel contract DEPENDS_ON AsyncAPI artifact
```

Documentation may depend on the interface as well:

```text
docs/orders-api.md DEPENDS_ON rest:orders:get:/orders/{id}
```

## Cross-repository identity

RepoGraph should connect interfaces across repositories only when identity is justified.

Acceptable evidence includes:

- the same explicit OpenAPI contract/operation identity;
- WSDL namespace + service/interface/operation identity;
- AsyncAPI/channel identity;
- generated-client provenance;
- explicit consumer mapping.

Do not use fuzzy URL similarity, service-name guesses or LLM similarity as authoritative matching.

Do not equate raw JMS queue/topic names across unrelated brokers/environments when their scope is ambiguous.

## Persisted data

Persist only what queries need:

```text
Boundary:
  kind = interface
  key = canonical provider-scoped identity
```

Optional evidence:

- provider id/version;
- protocol family;
- contract artifact/path;
- operation/channel identity;
- complete/partial state.

Do not persist by default:

- complete OpenAPI/WSDL/AsyncAPI parse trees;
- SOAP envelope definitions;
- every request parameter/header;
- example payloads;
- broker topology;
- runtime credentials;
- endpoint health;
- traffic statistics;
- arbitrary generated documentation.

The source contract/provider cache remains available when detailed inspection is needed.

## Provider behavior

Protocol providers follow the common provider contract in [providers.md](providers.md).

They emit normalized candidate facts only:

```text
Artifact
Boundary(kind=interface)
DEPENDS_ON
CONTAINS
artifact roles
compact evidence
```

They cannot expand the stable graph schema merely because their source format is richer.

## Acceptance examples

A useful protocol provider must prove that the graph can answer a real impact question with less noise.

### REST

Changing one OpenAPI operation reaches the specific client/server surface that depends on it, but not unrelated server internals.

### SOAP

Changing one WSDL operation reaches generated/configured consumers without requiring the full WSDL model in the graph.

### Messaging

Changing one channel/message contract reaches relevant producers/consumers, while changing an unrelated producer implementation does not blindly mark all consumers affected.

That precision is the reason interface boundaries exist.
