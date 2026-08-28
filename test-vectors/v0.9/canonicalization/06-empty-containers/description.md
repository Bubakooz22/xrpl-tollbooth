# Empty containers

Empty objects ({}) and empty arrays ([]) are legal JSON and must
digest identically regardless of source formatting. This fixture pins
the byte-level canonical form of empty containers ("{}", "[]") so
implementations that emit "{ }" or "[ ]" fail loudly.
