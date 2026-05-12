//go:build ignore

package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

type operation struct {
	Method      string
	Path        string
	OperationID string
	Body        map[string]any
	Responses   map[string]any
	Params      []string
	Error       bool
}

func main() {
	openapi, err := os.ReadFile("openapi.yaml")
	if err != nil {
		panic(err)
	}
	var spec map[string]any
	if err := yaml.Unmarshal(openapi, &spec); err != nil {
		fmt.Println("openapi.yaml is not parseable YAML:", err)
		os.Exit(1)
	}
	doc := string(openapi)
	server, err := os.ReadFile("internal/server/server.go")
	if err != nil {
		panic(err)
	}
	types, err := os.ReadFile("frontend/src/api/generated/types.ts")
	if err != nil {
		panic(err)
	}
	routes := implementedRoutes(string(server))
	ops := documentedOperations(spec)
	failures := []string{}
	for route := range routes {
		if _, ok := ops[route]; !ok {
			failures = append(failures, "missing OpenAPI operation: "+route)
		}
	}
	for route, op := range ops {
		if !routes[route] {
			failures = append(failures, "OpenAPI operation has no backend handler: "+route)
		}
		if op.OperationID == "" {
			failures = append(failures, "OpenAPI operation missing operationId: "+route)
		}
		if len(op.Responses) == 0 {
			failures = append(failures, "OpenAPI operation missing responses: "+route)
		}
		if writesBody(op.Method) && len(op.Body) == 0 && !strings.Contains(route, "/open") && !strings.Contains(route, "/cancel") && !strings.Contains(route, "/validate") {
			failures = append(failures, "OpenAPI write operation missing requestBody: "+route)
		}
		if shouldHaveErrorResponse(route, op.Method) && !op.Error {
			failures = append(failures, "OpenAPI operation missing error response: "+route)
		}
		for _, name := range pathParams(route) {
			if !containsString(op.Params, name) {
				failures = append(failures, "OpenAPI operation missing path parameter "+name+": "+route)
			}
		}
		for _, name := range expectedQueryParams(route) {
			if !containsString(op.Params, name) {
				failures = append(failures, "OpenAPI operation missing query parameter "+name+": "+route)
			}
		}
		for _, status := range expectedResponseStatuses(route) {
			if responseRef(op.Responses[status]) == "" {
				failures = append(failures, "OpenAPI operation missing response status "+status+": "+route)
			}
		}
		for status, response := range op.Responses {
			if !validResponseRef(response) {
				failures = append(failures, "OpenAPI response lacks shared schema "+status+": "+route)
			}
		}
		if expected := expectedSuccessResponse(route); expected != "" {
			actual := responseRef(op.Responses["200"])
			if actual == "" {
				actual = responseRef(op.Responses["201"])
			}
			if actual == "" {
				actual = responseRef(op.Responses["202"])
			}
			if actual != expected {
				failures = append(failures, "OpenAPI success response drift "+route+": got "+actual+" want "+expected)
			}
		}
		if len(op.Body) > 0 && !validRequestBody(op.Body) {
			failures = append(failures, "OpenAPI requestBody lacks schema: "+route)
		}
	}
	for name, response := range asMap(asMap(spec["components"])["responses"]) {
		if name == "Error" {
			continue
		}
		schema := responseSchemaRef(response)
		if schema == "" || schema == "#/components/schemas/ResourceEnvelope" || schema == "#/components/schemas/ListEnvelope" {
			failures = append(failures, "OpenAPI response component is not concrete: "+name)
		}
	}
	for _, code := range implementedErrorCodes() {
		if !strings.Contains(doc, code) {
			failures = append(failures, "missing OpenAPI error code: "+code)
		}
	}
	for _, required := range []string{"Repository", "Session", "Candidate", "ModuleRecord", "AgentJob", "Blueprint", "ValidateEdgeRequest"} {
		if !strings.Contains(string(types), "interface "+required) {
			failures = append(failures, "missing generated frontend type: "+required)
		}
	}
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(openapi))
	if firstLine := strings.SplitN(string(types), "\n", 2)[0]; !strings.Contains(firstLine, expectedHash) {
		failures = append(failures, "generated frontend API types are stale for openapi.yaml")
	}
	for _, token := range []string{
		"reusableRationale", "couplingNotes", "dependencies", "sideEffects", "testsFound", "missingTests",
		"targetLanguage", "confidence", "extractionRisk", "workbenchNode",
		"sourceFiles", "testFiles", "extractionJobId", "ValidateEdge", "blueprint.port_type_mismatch",
	} {
		if !strings.Contains(doc, token) {
			failures = append(failures, "missing OpenAPI schema token: "+token)
		}
	}
	if len(failures) == 0 {
		return
	}
	sort.Strings(failures)
	for _, failure := range failures {
		fmt.Println(failure)
	}
	os.Exit(1)
}

func implementedRoutes(server string) map[string]bool {
	re := regexp.MustCompile(`mux\.HandleFunc\("([A-Z]+) (/api/[^"]+)"`)
	out := map[string]bool{}
	for _, match := range re.FindAllStringSubmatch(server, -1) {
		out[match[1]+" "+match[2]] = true
	}
	return out
}

func documentedOperations(spec map[string]any) map[string]operation {
	paths := asMap(spec["paths"])
	out := map[string]operation{}
	for path, rawPath := range paths {
		pathObj := asMap(rawPath)
		pathParams := parameterNames(pathObj["parameters"])
		for _, method := range []string{"get", "post", "patch", "put", "delete"} {
			rawOp, ok := pathObj[method]
			if !ok {
				continue
			}
			opObj := asMap(rawOp)
			responses := asMap(opObj["responses"])
			op := operation{
				Method:      strings.ToUpper(method),
				Path:        path,
				OperationID: stringValue(opObj["operationId"]),
				Body:        asMap(opObj["requestBody"]),
				Responses:   responses,
				Params:      append(pathParams, parameterNames(opObj["parameters"])...),
			}
			for _, response := range responses {
				if responseRef(response) == "#/components/responses/Error" {
					op.Error = true
				}
			}
			out[op.Method+" "+path] = op
		}
	}
	return out
}

func validResponseRef(raw any) bool {
	ref := responseRef(raw)
	return strings.HasPrefix(ref, "#/components/responses/") && ref != "#/components/responses/JSON" && ref != "#/components/responses/List"
}

func expectedSuccessResponse(route string) string {
	expected := map[string]string{
		"GET /api/health":                                           "#/components/responses/Health",
		"GET /api/config":                                           "#/components/responses/Config",
		"POST /api/repositories":                                    "#/components/responses/Repository",
		"GET /api/repositories":                                     "#/components/responses/RepositoryList",
		"POST /api/sessions":                                        "#/components/responses/Session",
		"GET /api/sessions":                                         "#/components/responses/SessionList",
		"GET /api/sessions/{sessionId}":                             "#/components/responses/Session",
		"GET /api/sessions/{sessionId}/files":                       "#/components/responses/SourceFile",
		"POST /api/sessions/{sessionId}/intent":                     "#/components/responses/Session",
		"POST /api/sessions/{sessionId}/analysis-jobs":              "#/components/responses/AgentJob",
		"GET /api/candidates":                                       "#/components/responses/CandidateList",
		"PATCH /api/candidates/{candidateId}":                       "#/components/responses/Candidate",
		"POST /api/candidates/{candidateId}/approve":                "#/components/responses/Candidate",
		"POST /api/candidates/{candidateId}/reject":                 "#/components/responses/Candidate",
		"POST /api/candidates/{candidateId}/defer":                  "#/components/responses/Candidate",
		"POST /api/candidates/{candidateId}/duplicate":              "#/components/responses/Candidate",
		"POST /api/candidates/{candidateId}/rescan":                 "#/components/responses/Candidate",
		"POST /api/extraction-plans":                                "#/components/responses/ExtractionPlan",
		"GET /api/extraction-plans/{planId}":                        "#/components/responses/ExtractionPlan",
		"POST /api/extraction-plans/{planId}/jobs":                  "#/components/responses/AgentJob",
		"GET /api/modules":                                          "#/components/responses/ModuleList",
		"POST /api/modules":                                         "#/components/responses/Module",
		"GET /api/modules/{moduleId}":                               "#/components/responses/Module",
		"POST /api/modules/{moduleId}/compare":                      "#/components/responses/RegistryComparison",
		"POST /api/spec-enrichments":                                "#/components/responses/SpecEnrichment",
		"GET /api/spec-enrichments/{enrichmentId}":                  "#/components/responses/SpecEnrichment",
		"POST /api/spec-enrichments/{enrichmentId}/jobs":            "#/components/responses/AgentJob",
		"POST /api/compositions":                                    "#/components/responses/Composition",
		"GET /api/compositions/{compositionId}":                     "#/components/responses/Composition",
		"PATCH /api/compositions/{compositionId}/layout":            "#/components/responses/Composition",
		"POST /api/compositions/{compositionId}/clarification-jobs": "#/components/responses/AgentJob",
		"POST /api/compositions/{compositionId}/answers":            "#/components/responses/Composition",
		"POST /api/compositions/{compositionId}/compile-jobs":       "#/components/responses/AgentJob",
		"GET /api/workbench/palette":                                "#/components/responses/ModuleList",
		"POST /api/workbench/validate-edge":                         "#/components/responses/EdgeValidation",
		"POST /api/blueprints":                                      "#/components/responses/Blueprint",
		"GET /api/blueprints":                                       "#/components/responses/BlueprintList",
		"GET /api/blueprints/{blueprintId}":                         "#/components/responses/Blueprint",
		"PATCH /api/blueprints/{blueprintId}":                       "#/components/responses/Blueprint",
		"POST /api/blueprints/{blueprintId}/validate":               "#/components/responses/Blueprint",
		"POST /api/blueprints/{blueprintId}/wiring-jobs":            "#/components/responses/AgentJob",
		"GET /api/agent-jobs":                                       "#/components/responses/AgentJobList",
		"GET /api/agent-jobs/{jobId}":                               "#/components/responses/AgentJob",
		"POST /api/agent-jobs/{jobId}/open":                         "#/components/responses/JobOpen",
		"POST /api/agent-jobs/{jobId}/cancel":                       "#/components/responses/AgentJob",
	}
	return expected[route]
}

func expectedQueryParams(route string) []string {
	expected := map[string][]string{
		"GET /api/candidates": {"sessionId", "repositoryId", "status", "extractionRisk", "confidence", "capability"},
	}
	return expected[route]
}

func expectedResponseStatuses(route string) []string {
	expected := map[string][]string{
		"POST /api/repositories":                                    {"201", "400", "409"},
		"POST /api/sessions":                                        {"201", "400", "404", "502"},
		"GET /api/sessions/{sessionId}/files":                       {"200", "400", "404"},
		"POST /api/sessions/{sessionId}/intent":                     {"200", "400", "404", "409"},
		"POST /api/sessions/{sessionId}/analysis-jobs":              {"200", "202", "400", "404", "409", "502"},
		"PATCH /api/candidates/{candidateId}":                       {"200", "400", "404", "409"},
		"POST /api/candidates/{candidateId}/approve":                {"200", "400", "404", "409"},
		"POST /api/candidates/{candidateId}/reject":                 {"200", "400", "404", "409"},
		"POST /api/candidates/{candidateId}/defer":                  {"200", "400", "404", "409"},
		"POST /api/candidates/{candidateId}/duplicate":              {"200", "400", "404", "409"},
		"POST /api/candidates/{candidateId}/rescan":                 {"200", "400", "404", "409"},
		"POST /api/extraction-plans":                                {"201", "400", "404", "409"},
		"POST /api/extraction-plans/{planId}/jobs":                  {"200", "202", "400", "404", "502"},
		"POST /api/modules":                                         {"201", "400", "422"},
		"POST /api/modules/{moduleId}/compare":                      {"200", "400", "404"},
		"POST /api/spec-enrichments":                                {"201", "400"},
		"POST /api/spec-enrichments/{enrichmentId}/jobs":            {"200", "202", "400", "404", "502"},
		"POST /api/compositions":                                    {"201", "400", "404"},
		"PATCH /api/compositions/{compositionId}/layout":            {"200", "400", "404"},
		"POST /api/compositions/{compositionId}/clarification-jobs": {"200", "202", "400", "404", "502"},
		"POST /api/compositions/{compositionId}/answers":            {"200", "400", "404"},
		"POST /api/compositions/{compositionId}/compile-jobs":       {"200", "202", "400", "404", "409", "502"},
		"POST /api/workbench/validate-edge":                         {"200", "400", "404", "422"},
		"POST /api/blueprints":                                      {"201", "400", "422"},
		"PATCH /api/blueprints/{blueprintId}":                       {"200", "400", "422"},
		"POST /api/blueprints/{blueprintId}/validate":               {"200", "404", "422"},
		"POST /api/blueprints/{blueprintId}/wiring-jobs":            {"200", "202", "400", "404", "409", "502"},
		"POST /api/agent-jobs/{jobId}/open":                         {"200", "404", "409", "502"},
		"POST /api/agent-jobs/{jobId}/cancel":                       {"200", "404", "409", "502"},
	}
	return expected[route]
}

func responseRef(raw any) string {
	return stringValue(asMap(raw)["$ref"])
}

func responseSchemaRef(raw any) string {
	content := asMap(asMap(raw)["content"])
	jsonBody := asMap(content["application/json"])
	schema := asMap(jsonBody["schema"])
	if ref := stringValue(schema["$ref"]); ref != "" {
		return ref
	}
	if refs, ok := schema["oneOf"].([]any); ok && len(refs) > 0 {
		return stringValue(asMap(refs[0])["$ref"])
	}
	return ""
}

func validRequestBody(raw map[string]any) bool {
	if ref := stringValue(raw["$ref"]); strings.HasPrefix(ref, "#/components/requestBodies/") {
		return true
	}
	content := asMap(raw["content"])
	jsonBody := asMap(content["application/json"])
	return len(asMap(jsonBody["schema"])) > 0
}

func parameterNames(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(items))
	for _, item := range items {
		ref := stringValue(asMap(item)["$ref"])
		if ref == "" {
			if name := stringValue(asMap(item)["name"]); name != "" {
				names = append(names, name)
			}
			continue
		}
		names = append(names, paramName(filepath.Base(ref)))
	}
	return names
}

func pathParams(path string) []string {
	matches := regexp.MustCompile(`\{([^}]+)\}`).FindAllStringSubmatch(path, -1)
	out := make([]string, 0, len(matches))
	for _, match := range matches {
		out = append(out, match[1])
	}
	return out
}

func writesBody(method string) bool {
	return method == "POST" || method == "PATCH" || method == "PUT"
}

func shouldHaveErrorResponse(route, method string) bool {
	return method != "GET" || strings.Contains(route, "{")
}

func paramName(component string) string {
	switch component {
	case "SessionId":
		return "sessionId"
	case "CandidateId":
		return "candidateId"
	case "PlanId":
		return "planId"
	case "ModuleId":
		return "moduleId"
	case "BlueprintId":
		return "blueprintId"
	case "JobId":
		return "jobId"
	case "EnrichmentId":
		return "enrichmentId"
	case "CompositionId":
		return "compositionId"
	case "SessionFilter":
		return "sessionId"
	case "RepositoryFilter":
		return "repositoryId"
	case "StatusFilter":
		return "status"
	case "RiskFilter":
		return "extractionRisk"
	case "ConfidenceFilter":
		return "confidence"
	case "CapabilityFilter":
		return "capability"
	default:
		return strings.TrimSuffix(component, "Id")
	}
}

func implementedErrorCodes() []string {
	files, err := filepath.Glob("internal/server/*.go")
	if err != nil {
		panic(err)
	}
	re := regexp.MustCompile(`Code:\s*"([^"]+)"`)
	seen := map[string]bool{}
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			panic(err)
		}
		for _, match := range re.FindAllStringSubmatch(string(b), -1) {
			seen[match[1]] = true
		}
	}
	out := make([]string, 0, len(seen))
	for code := range seen {
		out = append(out, code)
	}
	sort.Strings(out)
	return out
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func stringValue(v any) string {
	s, _ := v.(string)
	return s
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}
