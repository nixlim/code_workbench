package config

import (
	"flag"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	DefaultAnalysisLimit   = 4
	DefaultExtractionLimit = 2
	DefaultWiringLimit     = 1
)

type Config struct {
	Host            string
	Port            int
	DataDir         string
	AllowedRoots    []string
	AllowedExplicit bool
	Dev             bool
	EnableFake      bool
	AnalysisLimit   int
	ExtractionLimit int
	WiringLimit     int
}

type rootFlags []string

func (r *rootFlags) String() string { return strings.Join(*r, string(os.PathListSeparator)) }
func (r *rootFlags) Set(v string) error {
	*r = append(*r, v)
	return nil
}

func Parse(args []string) (Config, error) {
	var roots rootFlags
	cfg := Config{
		Host:            "127.0.0.1",
		Port:            5174,
		DataDir:         "data",
		AnalysisLimit:   DefaultAnalysisLimit,
		ExtractionLimit: DefaultExtractionLimit,
		WiringLimit:     DefaultWiringLimit,
	}
	fs := flag.NewFlagSet("workbench", flag.ContinueOnError)
	fs.StringVar(&cfg.Host, "host", cfg.Host, "HTTP host")
	fs.IntVar(&cfg.Port, "port", cfg.Port, "HTTP port")
	fs.StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "data directory")
	fs.Var(&roots, "allowed-root", "allowed local repository root; may be repeated")
	fs.BoolVar(&cfg.Dev, "dev", false, "serve API only for frontend dev server")
	fs.BoolVar(&cfg.EnableFake, "enable-fake-provider", false, "enable fake agent provider for tests")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}

	absData, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return cfg, err
	}
	cfg.DataDir = filepath.Clean(absData)

	if len(roots) > 0 {
		cfg.AllowedExplicit = true
		cfg.AllowedRoots = cleanRoots(roots)
		return cfg, nil
	}
	if env, ok := os.LookupEnv("CODE_WORKBENCH_ALLOWED_ROOTS"); ok {
		cfg.AllowedExplicit = true
		if env == "" {
			cfg.AllowedRoots = []string{}
		} else {
			cfg.AllowedRoots = cleanRoots(filepath.SplitList(env))
		}
		return cfg, nil
	}
	wd, err := os.Getwd()
	if err != nil {
		return cfg, err
	}
	cfg.AllowedRoots = cleanRoots([]string{wd})
	return cfg, nil
}

func cleanRoots(in []string) []string {
	out := make([]string, 0, len(in))
	for _, root := range in {
		if strings.TrimSpace(root) == "" {
			continue
		}
		if runtime.GOOS == "windows" {
			root = strings.ReplaceAll(root, "\\", "/")
		}
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		out = append(out, filepath.Clean(abs))
	}
	return out
}

func (c Config) Providers() []string {
	providers := []string{"claude_code_tmux"}
	if c.EnableFake {
		providers = append(providers, "fake")
	}
	return providers
}

func (c Config) TimeoutSeconds(role string) int {
	switch role {
	case "repo_analysis", "module_test", "documentation":
		return 1800
	case "extraction", "wiring":
		return 3600
	case "registry_comparison", "blueprint_validation":
		return 900
	default:
		return 900
	}
}

func (c Config) LimitForRole(role string) int {
	switch role {
	case "repo_analysis":
		return c.AnalysisLimit
	case "extraction":
		return c.ExtractionLimit
	case "wiring":
		return c.WiringLimit
	default:
		return 1
	}
}
